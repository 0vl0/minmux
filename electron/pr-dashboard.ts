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

const exec = promisify(execFile)

/** Runs gh / git in `cwd` (host, or inside a WSL distro) → stdout; rejects with execFile's error. */
// `token`: gh runs as that account (GH_TOKEN), never by switching gh's active one.
export type PrRunner = (
  cmd: "gh" | "git",
  args: string[],
  cwd: string,
  wsl?: { distro?: string },
  token?: string,
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

const defaultRunner: PrRunner = async (cmd, args, cwd, wsl, token) => {
  const env = tokenEnv(process.env, token, !!wsl)
  const opts = { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env }
  if (wsl) return (await exec("wsl.exe", wslArgs(wsl.distro, cwd, cmd, args, true), opts)).stdout
  return (await exec(cmd, args, { ...opts, cwd })).stdout
}

/** `gh auth status --json hosts` → github.com's accounts (none: not an answer). */
export function parseAccounts(out: string): GhAccount[] {
  try {
    const list = (JSON.parse(out) as { hosts?: Record<string, unknown> }).hosts?.["github.com"]
    if (!Array.isArray(list)) return []
    return list.flatMap((a: unknown) => {
      const o = a as { login?: unknown; active?: unknown; state?: unknown }
      return typeof o?.login === "string" && /^[A-Za-z0-9][\w-]*$/.test(o.login)
        ? [{ login: o.login, active: o.active === true, ok: o.state === "success" }]
        : []
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

const REPO_TTL = 60_000
const ACCOUNTS_TTL = 60_000 // a `gh auth login` elsewhere shows within a minute
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
  if (err.code === 4) return { error: "unauthenticated" }
  const stderr = String(err.stderr ?? "")
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
  private accountsCache = new Map<string, { list: GhAccount[]; at: number }>()
  private tokens = new Map<string, { token: string; at: number }>() // in main only, never sent
  private repoAccounts = new Map<string, string>() // owner → the account that saw its repos
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
  async accounts(wsl?: { distro?: string }): Promise<GhAccount[]> {
    const key = wsl ? `wsl:${wsl.distro ?? ""}` : "host"
    const hit = this.accountsCache.get(key)
    if (hit && this.now() - hit.at < ACCOUNTS_TTL) return hit.list
    const home = wsl ? "~" : os.homedir()
    // (it exits 0 with --json whatever the accounts' state; an old gh without --json: none)
    const list = await this.run("gh", ["auth", "status", "--json", "hosts"], home, wsl).then(
      parseAccounts,
      () => [],
    )
    this.accountsCache.set(key, { list, at: this.now() })
    return list
  }

  /** One account's token, for its runs only (never leaves main). undefined: none to use. */
  private async token(login: string | undefined, wsl?: { distro?: string }) {
    if (!login) return undefined
    const key = `${wsl ? `wsl:${wsl.distro ?? ""}` : "host"}:${login}`
    const hit = this.tokens.get(key)
    if (hit && this.now() - hit.at < TOKEN_TTL) return hit.token
    const args = ["auth", "token", "--hostname", "github.com", "--user", login]
    const token = (await this.run("gh", args, wsl ? "~" : os.homedir(), wsl)).trim()
    if (!token || /\s/.test(token)) throw new Error(`no token for ${login}`)
    this.tokens.set(key, { token, at: this.now() })
    return token
  }

  /** The account a PR request runs as: its own when several are logged in, else gh's active. */
  private async tokenFor(req: { account?: string; wsl?: { distro?: string } }) {
    if (!req.account) return undefined
    const accounts = await this.accounts(req.wsl)
    if (accounts.length < 2 || !accounts.some((a) => a.login === req.account)) return undefined
    return this.token(req.account, req.wsl)
  }

  private async fetch(req: PrListsRequest): Promise<PrListsResult> {
    // A folder that's gone (a removed worktree): gh runs from home, else its ENOENT would read
    // as "gh isn't installed". (WSL: wsl.exe starts either way; a gone folder fails git.)
    const there = !!req.cwd && (!!req.wsl || (await this.dirExists(req.cwd)))
    const cwd = there ? req.cwd! : req.wsl ? "~" : os.homedir()
    const repo = there ? await this.repoOf(req.cwd!, req.wsl) : null
    // No repo there (a WSL folder that's gone too): gh runs from home.
    const at = repo || !req.wsl ? cwd : "~"
    const accounts = await this.accounts(req.wsl)
    // One account (or gh can't say): gh's own, as it is.
    if (accounts.length < 2) {
      const res = await this.fetchAs(req, repo, at, undefined)
      if (res.ok) res.lists.accounts = accounts
      return res
    }
    const owner = repo?.split("/")[0]?.toLowerCase() ?? ""
    const picked = accounts.find((a) => a.login === req.account)
    const order = picked
      ? [picked]
      : repoOrder(
          accounts.filter((a) => a.ok),
          this.repoAccounts.get(owner),
        )
    if (!order.length) return { ok: false, error: "unauthenticated" }
    const answers = await Promise.all(
      order.map(async (a) => {
        try {
          return { a, res: await this.fetchAs(req, repo, at, await this.token(a.login, req.wsl)) }
        } catch (e) {
          return { a, res: { ok: false, ...ghError(e) } as PrListsResult }
        }
      }),
    )
    const good = answers.filter((x) => x.res.ok) as {
      a: GhAccount
      res: { ok: true; lists: PrLists }
    }[]
    if (!good.length) return answers[0]!.res
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
      // The repo tab: the first account (in order) that can see the repo.
      const seer = good.find((x) => x.res.lists.repoVisible)
      lists.repoVisible = !!seer
      seen.clear()
      lists.repo = seer ? tag(seer.res.lists.repo ?? [], seer.a.login) : []
      if (seer) {
        lists.repoAccount = seer.a.login
        this.repoAccounts.set(owner, seer.a.login)
        if (this.repoAccounts.size > 64)
          this.repoAccounts.delete(this.repoAccounts.keys().next().value!)
      }
    }
    const notes = [
      ...answers
        .filter((x) => !x.res.ok)
        .map(
          (x) =>
            `@${x.a.login}: ${prErrorText(x.res as { error: PrListsError; message?: string })}`,
        ),
      ...good
        .filter((x) => x.res.lists.warning)
        .map((x) => `@${x.a.login}: ${x.res.lists.warning}`),
    ]
    if (notes.length) lists.warning = notes.join(" ")
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
  ): Promise<PrListsResult> {
    const s = prSearches(repo ?? undefined, req.closed, this.now())
    const [owner = "", name = ""] = repo?.split("/") ?? []
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `n=${PER_TAB}`]
    args.push("-f", `mine=${s.mine}`, "-f", `review=${s.review}`, "-f", `repo=${s.repo}`)
    args.push(
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
      // (the repo not resolving is said by repoVisible, not as a failure)
      const message = err.message && !/Could not resolve to a Repository/i.test(err.message)
      if (message) lists.warning = err.message
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
    const env = `${req.wsl ? `wsl:${req.wsl.distro ?? ""}` : "host"}:${req.account ?? ""}:${req.repo.split("/")[0]}`
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
      if (!teams || !READ_ORG.test(String((e as { stderr?: unknown }).stderr ?? "")))
        return { ok: false, ...ghError(e) }
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
      if (READ_ORG.test(String((e as { stderr?: unknown }).stderr ?? "")))
        return { ok: false, error: "failed", message: READ_ORG_HINT }
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
      return parsePrRowAnswer(await this.run("gh", args, cwd, req.wsl, token))
    } catch {
      return null
    }
  }
}
