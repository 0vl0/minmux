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
  type PrListsRequest,
  type PrListsResult,
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
export type PrRunner = (
  cmd: "gh" | "git",
  args: string[],
  cwd: string,
  wsl?: { distro?: string },
) => Promise<string>

const defaultRunner: PrRunner = async (cmd, args, cwd, wsl) => {
  const opts = { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  if (wsl) return (await exec("wsl.exe", wslArgs(wsl.distro, cwd, cmd, args, true), opts)).stdout
  return (await exec(cmd, args, { ...opts, cwd })).stdout
}

const hostDirExists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

const REPO_TTL = 60_000
const DETAIL_QUERY = PR_DETAIL_QUERY.replace(/\s+/g, " ")
const CANDIDATES_QUERY = PR_CANDIDATES_QUERY.replace(/\s+/g, " ")
const ROW_QUERY = PR_ROW_QUERY.replace(/\s+/g, " ")
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
  private gh = new Limiter(1) // its own slot: never queued behind (nor slowing) the sidebar's gh
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
    const key = JSON.stringify([req.cwd ?? "", req.wsl ? (req.wsl.distro ?? "") : null, req.closed])
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

  private async fetch(req: PrListsRequest): Promise<PrListsResult> {
    // A folder that's gone (a removed worktree): gh runs from home, else its ENOENT would read
    // as "gh isn't installed". (WSL: wsl.exe starts either way; a gone folder fails git.)
    const there = !!req.cwd && (!!req.wsl || (await this.dirExists(req.cwd)))
    const cwd = there ? req.cwd! : req.wsl ? "~" : os.homedir()
    const repo = there ? await this.repoOf(req.cwd!, req.wsl) : null
    const s = prSearches(repo ?? undefined, req.closed, this.now())
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `n=${PER_TAB}`]
    args.push("-f", `mine=${s.mine}`, "-f", `review=${s.review}`, "-f", `repo=${s.repo}`)
    args.push("-F", `withRepo=${repo ? "true" : "false"}`)
    try {
      // No repo there (a WSL folder that's gone too): gh runs from home.
      const at = repo || !req.wsl ? cwd : "~"
      const out = await this.gh.run(() => this.run("gh", args, at, req.wsl))
      const lists = parsePrLists(out, !!repo)
      if (!lists) return { ok: false, error: "failed", message: "Unexpected answer from gh" }
      if (repo) lists.repoName = repo
      return { ok: true, lists }
    } catch (e) {
      // A GraphQL error in one search (a repo it may not search) fails the run, but gh still
      // printed the others' data: those tabs show, with the error as a note.
      const stdout = (e as { stdout?: unknown }).stdout
      const lists = typeof stdout === "string" && stdout ? parsePrLists(stdout, !!repo) : null
      const err = ghError(e)
      if (!lists) return { ok: false, ...err }
      if (repo) lists.repoName = repo
      if (err.message) lists.warning = err.message
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
      const out = await this.run(
        "gh",
        ["api", "graphql", "-f", `query=${DETAIL_QUERY}`, ...vars],
        cwd,
        req.wsl,
      )
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
    const env = `${req.wsl ? `wsl:${req.wsl.distro ?? ""}` : "host"}:${req.repo.split("/")[0]}`
    const missingAt = this.noTeamScope.get(env)
    let teams = missingAt === undefined || this.now() - missingAt >= NO_SCOPE_TTL
    const q = req.query.trim().slice(0, QUERY_MAX)
    const ask = async (): Promise<PrCandidatesResult> => {
      const args = ["api", "graphql", "-f", `query=${CANDIDATES_QUERY}`, ...vars, "-f", `q=${q}`]
      args.push("-F", `suggest=${q ? "false" : "true"}`, "-F", `teams=${teams}`)
      const out = await this.run("gh", args, cwd, req.wsl)
      const candidates = parseCandidates(out, teams)
      return candidates
        ? { ok: true, candidates }
        : { ok: false, error: "failed", message: "Unexpected answer from gh" }
    }
    try {
      return await ask()
    } catch (e) {
      // Teams need read:org: without it, people only, and a hint (`gh auth refresh`).
      if (
        !teams ||
        !/read:org|INSUFFICIENT_SCOPES/i.test(String((e as { stderr?: unknown }).stderr ?? ""))
      )
        return { ok: false, ...ghError(e) }
      this.noTeamScope.set(env, this.now())
      if (this.noTeamScope.size > 64) this.noTeamScope.delete(this.noTeamScope.keys().next().value!)
      teams = false
      // gh still printed the rest of the answer: no second run when it's there.
      const stdout = (e as { stdout?: unknown }).stdout
      const partial = typeof stdout === "string" && stdout ? parseCandidates(stdout, false) : null
      if (partial) return { ok: true, candidates: partial }
      try {
        return await ask()
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
    let cwd: string
    try {
      cwd = await ghCwd(req, this.dirExists)
      await this.run("gh", args, cwd, req.wsl)
    } catch (e) {
      return { ok: false, ...ghError(e) }
    }
    const out = await this.run(
      "gh",
      ["api", "graphql", "-f", `query=${ROW_QUERY}`, ...vars],
      cwd,
      req.wsl,
    ).catch(() => "")
    return { ok: true, row: parsePrRowAnswer(out) }
  }
}
