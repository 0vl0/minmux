// The pull requests dialog's data (docs/design/PR_DASHBOARD.md): one `gh api graphql` query per
// refresh, in the focused pane's environment (host, or its WSL distro). Async and on its own
// IPC channel: nowhere near the PTY → renderer path. The user's own gh login; no token here.
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import os from "node:os"
import { promisify } from "node:util"
import { wslArgs } from "./git"
import { Limiter } from "./pane-git"
import {
  githubRepoOf,
  parsePrLists,
  parsePrRowAnswer,
  prSearches,
  PER_TAB,
  PR_QUERY,
  PR_ROW_QUERY,
  isGhLogin,
  prErrorText,
  type GhAccount,
  type PrLists,
  type PrListsError,
  type PrListsRequest,
  type PrListsResult,
  type PrRow,
} from "../src/lib/pr-dashboard"
import {
  parsePrDetail,
  PR_DETAIL_QUERY,
  type PrDetailRequest,
  type PrDetailResult,
} from "../src/lib/pr-detail"
import {
  parseCandidates,
  PR_CANDIDATES_QUERY,
  QUERY_MAX,
  reviewerEditArgs,
  type PrCandidatesRequest,
  type PrCandidatesResult,
  type PrReviewersRequest,
  type PrReviewersResult,
} from "../src/lib/pr-reviewers"
import { BODY_MAX, writeArgs, type PrWriteRequest, type PrWriteResult } from "../src/lib/pr-write"

const exec = promisify(execFile)

/** Runs gh / git in `cwd` (host, or inside a WSL distro) → stdout; rejects with execFile's error. */
// `token`: gh runs as that account (GH_TOKEN), never by switching gh's active one.
export type PrRunner = (
  cmd: "gh" | "git",
  args: string[],
  cwd: string,
  wsl?: { distro?: string },
  token?: string,
  input?: string, // written to its stdin (a comment's text: never on the command line)
) => Promise<string>

/** The environment a run gets: GH_TOKEN for one account (into WSL through WSLENV). */
export function tokenEnv(
  base: NodeJS.ProcessEnv,
  token: string | undefined,
  wsl: boolean,
): NodeJS.ProcessEnv | undefined {
  if (!token) return undefined
  const env: NodeJS.ProcessEnv = { ...base, GH_TOKEN: token }
  if (wsl) env.WSLENV = [base.WSLENV, "GH_TOKEN"].filter(Boolean).join(":")
  return env
}

const defaultRunner: PrRunner = async (cmd, args, cwd, wsl, token, input) => {
  const env = tokenEnv(process.env, token, !!wsl)
  const opts = { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env }
  if (input === undefined) {
    if (wsl) return (await exec("wsl.exe", wslArgs(wsl.distro, cwd, cmd, args, true), opts)).stdout
    return (await exec(cmd, args, { ...opts, cwd })).stdout
  }
  // With stdin (a write): execFile's own callback (its error carries stdout / stderr). A write
  // gets far longer before it's killed: killed after GitHub took it, a retry would post twice.
  const [file, argv] = wsl ? ["wsl.exe", wslArgs(wsl.distro, cwd, cmd, args, true)] : [cmd, args]
  const wopts = { ...opts, timeout: WRITE_TIMEOUT }
  return new Promise((resolve, reject) => {
    const child = execFile(file, argv, wsl ? wopts : { ...wopts, cwd }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout)),
    )
    child.stdin?.on("error", () => {}) // gh gone before reading: its own error says why
    child.stdin?.end(input)
  })
}

/** `gh auth status --json hosts` → github.com's accounts (none: not an answer). */
export function parseAccounts(out: string): GhAccount[] {
  try {
    const list = (JSON.parse(out) as { hosts?: Record<string, unknown> }).hosts?.["github.com"]
    if (!Array.isArray(list)) return []
    return list.flatMap((a: unknown) => {
      const o = a as { login?: unknown; active?: unknown; state?: unknown }
      if (!isGhLogin(o?.login)) return []
      // "error": its token is bad; "timeout" (offline): unknown, so still used
      const acc: GhAccount = { login: o.login, active: o.active === true, ok: o.state !== "error" }
      return [o.state === "timeout" ? { ...acc, offline: true } : acc]
    })
  } catch {
    return []
  }
}

/** Accounts in the order the repo tab tries them: the one that saw it last, gh's active one, the rest. */
export function repoOrder(accounts: GhAccount[], remembered?: string): GhAccount[] {
  const rank = (a: GhAccount) => (a.login === remembered ? 0 : a.active ? 1 : 2)
  return [...accounts].sort((a, b) => rank(a) - rank(b))
}

const hostDirExists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

/** The gh environment a cache entry is for: the host, or a WSL distro. */
const envKey = (wsl?: { distro?: string }) => (wsl ? `wsl:${wsl.distro ?? ""}` : "host")

/** A request for an account gh no longer has (or can't vouch for): refused, never rerouted. */
const signedOut = (login: string) =>
  Object.assign(new Error(`@${login} isn't logged in to gh`), {
    code: 4,
    refused: true,
    stderr: `@${login} isn't logged in to gh here: run gh auth login, or pick another account.`,
  })

const WRITE_TIMEOUT = 120_000
const REPO_TTL = 60_000
const ACCOUNTS_TTL = 60_000 // a `gh auth login` elsewhere shows within a minute
const ACCOUNTS_RETRY = 10_000 // offline, or gh failing: asked again soon, not on every call
const TOKEN_TTL = 10 * 60_000
const DETAIL_QUERY = PR_DETAIL_QUERY.replace(/\s+/g, " ")
const CANDIDATES_QUERY = PR_CANDIDATES_QUERY.replace(/\s+/g, " ")
const ROW_QUERY = PR_ROW_QUERY.replace(/\s+/g, " ")
const READ_ORG = /read:org/i
const READ_ORG_HINT = "It needs gh's read:org scope: run gh auth refresh -s read:org"
const NO_SCOPE_TTL = 10 * 60_000 // then teams are tried again (`gh auth refresh` may have run)
const QUERY = PR_QUERY.replace(/\s+/g, " ") // one line (newlines don't survive a Windows command line)

// Prefers `upstream` (a fork's PRs live there), then `origin`, then any GitHub remote.
/** `git remote -v` → the checkout's GitHub repo (null: none). */
export function repoFromRemotes(out: string): string | null {
  const by = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    const [name, url] = line.split(/\s+/)
    const repo = url ? githubRepoOf(url) : null
    if (name && repo && !by.has(name)) by.set(name, repo)
  }
  return by.get("upstream") ?? by.get("origin") ?? by.values().next().value ?? null
}

/** Classify a failed gh run: not installed, logged out, offline, or anything else. */
export function ghError(e: unknown): {
  error: "missing" | "unauthenticated" | "offline" | "failed"
  message?: string
} {
  const err = e as { code?: string | number; stderr?: string; killed?: boolean }
  if (err.code === "ENOENT" || err.code === 127) return { error: "missing" }
  // WSL with `-e` (no shell, so no 127): wsl.exe reports the failed exec itself.
  if (/execvpe?\(gh\) failed|gh: (?:command )?not found/i.test(String(err.stderr ?? "")))
    return { error: "missing" }
  const stderr = String(err.stderr ?? "")
  // logged out (gh's exit 4), or a token GitHub refuses (revoked, rotated): with gh's reason
  if (err.code === 4 || /HTTP 401|Bad credentials/i.test(stderr)) {
    const why = stderr
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim()
    return why
      ? { error: "unauthenticated", message: why.slice(0, 300) }
      : { error: "unauthenticated" }
  }
  if (
    err.killed ||
    /could not resolve host|network is unreachable|timeout|ECONN|dial tcp/i.test(stderr)
  )
    return { error: "offline" }
  const message = stderr
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim()
  return message ? { error: "failed", message: message.slice(0, 300) } : { error: "failed" }
}

type Failure = { ok: false } & ReturnType<typeof ghError>
const SUPERSEDED: Failure = { ok: false, error: "failed", message: "Superseded" }

// One run at a time, and only the newest request waits: moving through the list (or typing),
// the requests passed over are skipped (answered "superseded"), never run one after another.
/** A latest-wins queue of one. */
export class LatestLane<Req, Res> {
  private busy = false
  private next: { req: Req; resolve: (r: Res | Failure) => void } | null = null

  constructor(private readonly work: (req: Req) => Promise<Res>) {}

  run(req: Req): Promise<Res | Failure> {
    return new Promise((resolve) => {
      this.next?.resolve(SUPERSEDED)
      this.next = { req, resolve }
      this.pump()
    })
  }

  private pump(): void {
    if (this.busy || !this.next) return
    const { req, resolve } = this.next
    this.next = null
    this.busy = true
    void this.work(req)
      .catch((e): Failure => ({ ok: false, ...ghError(e) })) // an answer, never a hang
      .then(resolve)
      .finally(() => {
        this.busy = false
        this.pump()
      })
  }
}

/** The folder gh runs in: the pane's (home if it's gone; WSL: the distro's home). */
const ghCwd = async (
  req: { cwd?: string; wsl?: { distro?: string } },
  dirExists: (p: string) => Promise<boolean>,
): Promise<string> => {
  if (req.wsl) return "~"
  return req.cwd && (await dirExists(req.cwd)) ? req.cwd : os.homedir()
}

/** owner/name + number → gh's variables (null: not a PR). */
const prVars = (repo: string, number: number): string[] | null => {
  const [owner, name, extra] = repo.split("/")
  if (!owner || !name || extra !== undefined || !Number.isInteger(number)) return null
  return ["-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]
}

/** Answers `prs:lists`: one query in flight per request; each checkout's repo cached briefly. */
export class PrDashboard {
  private repos = new Map<string, { repo: string | null; at: number }>()
  private inFlight = new Map<string, Promise<PrListsResult>>()
  private detailsInFlight = new Map<string, Promise<PrDetailResult>>()
  private gh = new Limiter(2) // its own slots: never queued behind (nor slowing) the sidebar's gh
  private accountsCache = new Map<string, { list: GhAccount[]; until: number; failed: boolean }>()
  private tokens = new Map<string, { token: string; at: number }>() // in main only, never sent
  private repoAccounts = new Map<string, string>() // owner → the account that saw its repos
  private running = new Map<string, Promise<unknown>>()
  // A PR's detail and the reviewer search: each its own lane (never waits for the lists'
  // refresh), newest request only.
  private detailLane = new LatestLane((r: PrDetailRequest) => this.fetchDetail(r))
  private candidatesLane = new LatestLane((r: PrCandidatesRequest) => this.fetchCandidates(r))
  private noTeamScope = new Map<string, number>() // gh environment → when read:org was missing

  constructor(
    private readonly run: PrRunner = defaultRunner,
    private readonly now: () => number = Date.now,
    private readonly dirExists: (p: string) => Promise<boolean> = hostDirExists,
  ) {}

  /** The lists for the dialog (the same request asked while it runs gets that one's answer). */
  lists(req: PrListsRequest): Promise<PrListsResult> {
    const key = JSON.stringify([
      req.cwd ?? "",
      req.wsl ? (req.wsl.distro ?? "") : null,
      req.closed,
      req.account ?? null,
    ])
    let p = this.inFlight.get(key)
    if (!p) {
      p = this.fetch(req).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, p)
    }
    return p
  }

  private async repoOf(cwd: string, wsl?: { distro?: string }): Promise<string | null> {
    const key = `${wsl ? `wsl:${wsl.distro ?? ""}:` : ""}${cwd}`
    const hit = this.repos.get(key)
    if (hit && this.now() - hit.at < REPO_TTL) return hit.repo
    const repo = await this.run("git", ["remote", "-v"], cwd, wsl).then(repoFromRemotes, () => null)
    this.repos.set(key, { repo, at: this.now() })
    if (this.repos.size > 64) this.repos.delete(this.repos.keys().next().value!)
    return repo
  }

  /** gh's accounts on github.com in this environment (cached briefly; none if gh can't say). */
  accounts(wsl?: { distro?: string }): Promise<GhAccount[]> {
    const key = envKey(wsl)
    const hit = this.accountsCache.get(key)
    if (hit && this.now() < hit.until) return Promise.resolve(hit.list)
    return this.once(`accounts:${key}`, async () => {
      const home = wsl ? "~" : os.homedir()
      // (it exits 0 with --json whatever the accounts' state; an old gh without --json: none)
      let failed = false
      const list = await this.run("gh", ["auth", "status", "--json", "hosts"], home, wsl).then(
        parseAccounts,
        () => ((failed = true), []),
      )
      // Offline, or gh itself failing: kept only briefly (back online, asked again soon).
      const ttl = failed || list.some((a) => a.offline) ? ACCOUNTS_RETRY : ACCOUNTS_TTL
      this.accountsCache.set(key, { list, until: this.now() + ttl, failed })
      return list
    })
  }

  /** The same work asked for while it runs: one run, shared. */
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = this.running.get(key) as Promise<T> | undefined
    if (running) return running
    const p = work().finally(() => this.running.delete(key))
    this.running.set(key, p)
    return p
  }

  /** gh refused an account's token (revoked, rotated): forget it, and the accounts' state. */
  // (`e`: a thrown gh error, or an answer that classified one; never our own refusal, which
  // gh never saw: forgetting then would only re-ask gh auth status on every request)
  private forget(login: string | undefined, wsl: { distro?: string } | undefined, e: unknown) {
    if (!login || (e as { refused?: boolean })?.refused) return
    const err =
      e && typeof e === "object" && "error" in e
        ? (e as { error: unknown }).error
        : ghError(e).error
    if (err !== "unauthenticated") return
    this.tokens.delete(`${envKey(wsl)}:${login}`)
    this.accountsCache.delete(envKey(wsl))
  }

  /** An account's token changed in gh (a scope added): the next run reads it again. */
  private dropToken(login: string | undefined, wsl?: { distro?: string }) {
    if (login) this.tokens.delete(`${envKey(wsl)}:${login}`)
  }

  /** One account's token, for its runs only (never leaves main). */
  private async token(login: string, wsl?: { distro?: string }): Promise<string> {
    const key = `${envKey(wsl)}:${login}`
    for (const [k, t] of this.tokens) if (this.now() - t.at >= TOKEN_TTL) this.tokens.delete(k)
    const hit = this.tokens.get(key)
    if (hit) return hit.token
    return this.once(`token:${key}`, async () => {
      const args = ["auth", "token", "--hostname", "github.com", "--user", login]
      const token = (await this.run("gh", args, wsl ? "~" : os.homedir(), wsl)).trim()
      if (!token || /\s/.test(token)) throw signedOut(login)
      this.tokens.set(key, { token, at: this.now() })
      return token
    })
  }

  // Strict: a request for an account runs as it or not at all, never as gh's active account
  // (a reviewer request would go out as someone else than the dialog says).
  /** The token a PR request runs with: its account's (none: gh's active, as it listed it). */
  private async tokenFor(req: { account?: string; wsl?: { distro?: string } }) {
    if (!req.account) return undefined
    const acc = (await this.accounts(req.wsl)).find((a) => a.login === req.account)
    if (!acc || !acc.ok) throw signedOut(req.account)
    return this.token(req.account, req.wsl)
  }

  private async fetch(req: PrListsRequest): Promise<PrListsResult> {
    // A folder that's gone (a removed worktree): gh runs from home, else its ENOENT would read
    // as "gh isn't installed". (WSL: wsl.exe starts either way; a gone folder fails git.)
    const there = !!req.cwd && (!!req.wsl || (await this.dirExists(req.cwd)))
    const cwd = there ? req.cwd! : req.wsl ? "~" : os.homedir()
    const [repo, accounts] = await Promise.all([
      there ? this.repoOf(req.cwd!, req.wsl) : null,
      this.accounts(req.wsl),
    ])
    // No repo there (a WSL folder that's gone too): gh runs from home.
    const at = repo || !req.wsl ? cwd : "~"
    // gh can't say (an old gh, or gh failing): its active account, as it is, untagged. Not
    // for a picked account, though: those lists would act as someone else.
    if (!accounts.length) {
      if (req.account)
        return {
          ok: false,
          error: "failed",
          message: "Couldn't ask gh which accounts are logged in.",
        }
      const res = await this.fetchAs(req, repo, at, undefined, { lists: true, repo: !!repo })
      if (res.ok) res.lists.accounts = accounts
      return res.ok ? res : { ...res, accounts }
    }
    const owner = repo?.split("/")[0]?.toLowerCase() ?? ""
    // A picked account that's signed out: every account's lists (the picker shows why).
    const picked = accounts.find((a) => a.login === req.account && a.ok)
    const order = picked
      ? [picked]
      : repoOrder(
          accounts.filter((a) => a.ok),
          this.repoAccounts.get(owner),
        )
    if (!order.length) return { ok: false, error: "unauthenticated", accounts }
    const as = async (a: GhAccount, what: { lists: boolean; repo: boolean }) => {
      try {
        const res = await this.fetchAs(req, repo, at, await this.token(a.login, req.wsl), what)
        if (!res.ok) this.forget(a.login, req.wsl, res) // a refused token: read again next time
        return { a, res }
      } catch (e) {
        this.forget(a.login, req.wsl, e)
        return { a, res: { ok: false, ...ghError(e) } as PrListsResult }
      }
    }
    // The repo is asked of the first account only (the one that saw it last, or gh's active);
    // the others are asked only when it can't see it.
    const answers = await Promise.all(
      order.map((a, i) => as(a, { lists: true, repo: !!repo && i === 0 })),
    )
    const okOf = (x: (typeof answers)[number]) =>
      x.res.ok ? (x as { a: GhAccount; res: { ok: true; lists: PrLists } }) : null
    let seer =
      repo && answers[0] && okOf(answers[0])?.res.lists.repoVisible ? okOf(answers[0]) : null
    const repoNotes: typeof answers = []
    // (only the repo part; an account whose lists just failed isn't asked again)
    if (repo && !seer)
      for (const a of order.slice(1).filter((_, i) => answers[i + 1]?.res.ok)) {
        const x = await as(a, { lists: false, repo: true })
        if (okOf(x)?.res.lists.repoVisible) {
          seer = okOf(x)
          break
        }
        if (!x.res.ok) repoNotes.push(x)
      }
    const good = answers.map(okOf).filter((x) => !!x)
    if (!good.length) {
      const first = answers[0]!.res as Exclude<PrListsResult, { ok: true }>
      // every account failed: each one's reason
      const message = answers
        .map(
          (x) =>
            `@${x.a.login}: ${prErrorText(x.res as { error: PrListsError; message?: string })}`,
        )
        .join(" ")
      return { ok: false, error: first.error, message, accounts }
    }
    // Mine and review requested: every account's, each PR once (tagged with its account).
    const lists: PrLists = { mine: [], review: [], accounts }
    const seen = new Set<string>()
    const tag = (rows: PrRow[], account: string) =>
      rows.filter((r) => !seen.has(r.url) && seen.add(r.url)).map((r) => ({ ...r, account }))
    for (const t of ["mine", "review"] as const) {
      seen.clear()
      for (const { a, res } of good) lists[t].push(...tag(res.lists[t], a.login))
      lists[t].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)) // newest first, as each was
    }
    if (repo) {
      lists.repoName = repo
      seen.clear()
      lists.repo = seer ? tag(seer.res.lists.repo ?? [], seer.a.login) : []
      // Unknown (not "nobody") when an account that might see it failed.
      const failed = answers.some((x) => !x.res.ok) || repoNotes.length > 0
      if (seer || !failed) lists.repoVisible = !!seer
      if (seer) {
        lists.repoAccount = seer.a.login
        this.repoAccounts.set(owner, seer.a.login)
        if (this.repoAccounts.size > 64)
          this.repoAccounts.delete(this.repoAccounts.keys().next().value!)
      }
    }
    const notes = [
      ...[...answers, ...repoNotes]
        .filter((x) => !x.res.ok)
        .map(
          (x) =>
            `@${x.a.login}: ${prErrorText(x.res as { error: PrListsError; message?: string })}`,
        ),
      ...good
        .filter((x) => x.res.lists.warning)
        .map((x) => `@${x.a.login}: ${x.res.lists.warning}`),
    ]
    if (notes.length) lists.warning = [...new Set(notes)].join(" ")
    const left = good.map((x) => x.res.lists.remaining).filter((n): n is number => n !== undefined)
    if (left.length) {
      const low = good.find((x) => x.res.lists.remaining === Math.min(...left))!
      lists.remaining = low.res.lists.remaining
      lists.resetAt = low.res.lists.resetAt
    }
    return { ok: true, lists }
  }

  /** The lists as one account (`token`; none: gh's active one). */
  private async fetchAs(
    req: PrListsRequest,
    repo: string | null,
    at: string,
    token: string | undefined,
    what: { lists: boolean; repo: boolean }, // mine + review requested; the repo's tab
  ): Promise<PrListsResult> {
    if (!what.repo) repo = null
    const s = prSearches(repo ?? undefined, req.closed, this.now())
    const [owner = "", name = ""] = repo?.split("/") ?? []
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `n=${PER_TAB}`]
    args.push("-f", `mine=${s.mine}`, "-f", `review=${s.review}`, "-f", `repo=${s.repo}`)
    args.push(
      "-F",
      `withLists=${what.lists}`,
      "-F",
      `withRepo=${repo ? "true" : "false"}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    )
    try {
      const out = await this.gh.run(() => this.run("gh", args, at, req.wsl, token))
      const lists = parsePrLists(out, !!repo)
      if (!lists) return { ok: false, error: "failed", message: "Unexpected answer from gh" }
      if (repo) lists.repoName = repo
      return { ok: true, lists }
    } catch (e) {
      // A GraphQL error in one part (a repo this account can't see, a search it may not run)
      // fails the run, but gh still printed the rest: those tabs show, with the error as a note.
      const stdout = (e as { stdout?: unknown }).stdout
      const lists = typeof stdout === "string" && stdout ? parsePrLists(stdout, !!repo) : null
      const err = ghError(e)
      if (!lists) return { ok: false, ...err }
      if (repo) lists.repoName = repo
      // The repo not resolving (and its search) is said by repoVisible, not as a failure; any
      // other error gh printed is the note.
      const unseen = lists.repoVisible === false
      const note = String((e as { stderr?: unknown }).stderr ?? "")
        .split(/\r?\n/)
        .map((l) => l.replace(/^gh:\s*/, "").trim())
        .find(
          (l) => l && !(unseen && /Could not resolve to a Repository|cannot be searched/i.test(l)),
        )
      if (note) lists.warning = note.slice(0, 300)
      return { ok: true, lists }
    }
  }

  /** One PR's body, conversation and review threads (the same request in flight: shared). */
  detail(req: PrDetailRequest): Promise<PrDetailResult> {
    const key = JSON.stringify([
      "detail",
      req.repo,
      req.number,
      req.wsl ? (req.wsl.distro ?? "") : null,
      req.account ?? null,
    ])
    let p = this.detailsInFlight.get(key)
    if (!p) {
      p = this.detailLane.run(req).finally(() => this.detailsInFlight.delete(key))
      this.detailsInFlight.set(key, p)
    }
    return p
  }

  private async fetchDetail(req: PrDetailRequest): Promise<PrDetailResult> {
    const vars = prVars(req.repo, req.number)
    if (!vars) return { ok: false, error: "failed", message: "Not a pull request" }
    // gh needs no checkout here: the pane's folder only picks its environment.
    const cwd = await ghCwd(req, this.dirExists)
    try {
      const token = await this.tokenFor(req)
      const args = ["api", "graphql", "-f", `query=${DETAIL_QUERY}`, ...vars]
      const out = await this.run("gh", args, cwd, req.wsl, token)
      const detail = parsePrDetail(out)
      return detail
        ? { ok: true, detail }
        : { ok: false, error: "failed", message: "Unexpected answer from gh" }
    } catch (e) {
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
  }

  /** Who can review a PR: suggestions (when the search is empty), people, and teams. */
  candidates(req: PrCandidatesRequest): Promise<PrCandidatesResult> {
    return this.candidatesLane.run(req)
  }

  private async fetchCandidates(req: PrCandidatesRequest): Promise<PrCandidatesResult> {
    const vars = prVars(req.repo, req.number)
    if (!vars) return { ok: false, error: "failed", message: "Not a pull request" }
    const cwd = await ghCwd(req, this.dirExists)
    // Per owner: only an org's teams need read:org (a user's repo has none to hide).
    const env = `${envKey(req.wsl)}:${req.account ?? ""}:${req.repo.split("/")[0]}`
    const missingAt = this.noTeamScope.get(env)
    let teams = missingAt === undefined || this.now() - missingAt >= NO_SCOPE_TTL
    const q = req.query.trim().slice(0, QUERY_MAX)
    const ask = async (): Promise<PrCandidatesResult> => {
      const args = ["api", "graphql", "-f", `query=${CANDIDATES_QUERY}`, ...vars, "-f", `q=${q}`]
      args.push("-F", `suggest=${q ? "false" : "true"}`, "-F", `teams=${teams}`)
      const out = await this.run("gh", args, cwd, req.wsl, await this.tokenFor(req))
      const candidates = parseCandidates(out, teams)
      return candidates
        ? { ok: true, candidates }
        : { ok: false, error: "failed", message: "Unexpected answer from gh" }
    }
    try {
      return await ask()
    } catch (e) {
      // Teams need read:org: without it, people only, and a hint (`gh auth refresh`).
      if (!teams || !READ_ORG.test(String((e as { stderr?: unknown }).stderr ?? ""))) {
        this.forget(req.account, req.wsl, e)
        return { ok: false, ...ghError(e) }
      }
      // (remembered only when people alone then answer: another scope's error isn't this)
      const remember = () => {
        this.noTeamScope.set(env, this.now())
        if (this.noTeamScope.size > 64)
          this.noTeamScope.delete(this.noTeamScope.keys().next().value!)
      }
      teams = false
      // gh still printed the rest of the answer: no second run when it's there.
      const stdout = (e as { stdout?: unknown }).stdout
      const partial = typeof stdout === "string" && stdout ? parseCandidates(stdout, false) : null
      if (partial) {
        remember()
        return { ok: true, candidates: partial }
      }
      try {
        const res = await ask()
        if (res.ok) remember()
        return res
      } catch (e2) {
        return { ok: false, ...ghError(e2) }
      }
    }
  }

  /** Requests (or un-requests) reviews, then fetches the PR's row again. Never skipped. */
  async reviewers(req: PrReviewersRequest): Promise<PrReviewersResult> {
    const args = reviewerEditArgs(req)
    const vars = prVars(req.repo, req.number)
    if (!args || !vars) return { ok: false, error: "failed", message: "Not a reviewer" }
    try {
      const cwd = await ghCwd(req, this.dirExists)
      await this.run("gh", args, cwd, req.wsl, await this.tokenFor(req))
    } catch (e) {
      // On an org's repo gh may look up its teams for any reviewer: that needs read:org.
      if (READ_ORG.test(String((e as { stderr?: unknown }).stderr ?? ""))) {
        this.dropToken(req.account, req.wsl) // after `gh auth refresh -s read:org`: the new one
        return { ok: false, error: "failed", message: READ_ORG_HINT }
      }
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
    return { ok: true, row: await this.row(req) }
  }

  /** Comments on a PR, or reviews it, as its account; then fetches its row again. */
  async write(req: PrWriteRequest): Promise<PrWriteResult> {
    if (req.body.length > BODY_MAX)
      return {
        ok: false,
        error: "failed",
        message: `Too long for GitHub (over ${BODY_MAX} characters)`,
      }
    const args = writeArgs(req)
    if (!args || !prVars(req.repo, req.number))
      return { ok: false, error: "failed", message: "Nothing to send" }
    try {
      const cwd = await ghCwd(req, this.dirExists)
      const token = await this.tokenFor(req)
      // (only the end trimmed: a first line's indent is Markdown, an indented code block)
      await this.run("gh", args, cwd, req.wsl, token, req.body.trimEnd())
    } catch (e) {
      // Killed waiting: GitHub may have taken it. Said so, never "offline" (a retry's cue).
      if ((e as { killed?: boolean }).killed)
        return {
          ok: false,
          error: "failed",
          message:
            "gh didn't answer in time: it may have gone through. Check the conversation before sending again.",
        }
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
    return { ok: true, row: await this.row(req) }
  }

  /** One PR's row, asked for directly (search answers lag behind edits). null: no answer. */
  async row(req: PrDetailRequest): Promise<PrRow | null> {
    const vars = prVars(req.repo, req.number)
    if (!vars) return null
    try {
      const cwd = await ghCwd(req, this.dirExists)
      const args = ["api", "graphql", "-f", `query=${ROW_QUERY}`, ...vars]
      const token = await this.tokenFor(req)
      const row = parsePrRowAnswer(await this.run("gh", args, cwd, req.wsl, token))
      // (as the account that listed it: its next requests go out as that one too)
      return row && req.account ? { ...row, account: req.account } : row
    } catch (e) {
      this.forget(req.account, req.wsl, e)
      return null
    }
  }
}
