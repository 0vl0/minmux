// The pull requests dialog's data (docs/design/PR_DASHBOARD.md): one `gh api graphql` query per
// refresh, in the focused pane's environment (host, or its WSL distro). Async and on its own
// IPC channel: nowhere near the PTY → renderer path. The user's own gh login; no token here.
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import os from "node:os"
import { promisify } from "node:util"
import { ghLimiter } from "./pane-git"
import {
  githubRepoOf,
  parsePrLists,
  prSearches,
  PER_TAB,
  PR_QUERY,
  type PrListsRequest,
  type PrListsResult,
} from "../src/lib/pr-dashboard"

const exec = promisify(execFile)

/** Runs gh / git in `cwd` (host, or inside a WSL distro) → stdout; rejects with execFile's error. */
export type PrRunner = (
  cmd: "gh" | "git",
  args: string[],
  cwd: string,
  wsl?: { distro?: string },
) => Promise<string>

// In WSL, `-e` runs gh itself, not through the distro's shell: the query's `$vars`, `(` and
// the searches' spaces reach gh as they are.
/** `wsl.exe` args to run `cmd args` in `distro` at Linux `cwd`, without a shell. */
export const wslExecArgs = (
  distro: string | undefined,
  cwd: string,
  cmd: string,
  args: string[],
) => [...(distro ? ["-d", distro] : []), "--cd", cwd, "-e", cmd, ...args]

const defaultRunner: PrRunner = async (cmd, args, cwd, wsl) => {
  const opts = { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  if (wsl) return (await exec("wsl.exe", wslExecArgs(wsl.distro, cwd, cmd, args), opts)).stdout
  return (await exec(cmd, args, { ...opts, cwd })).stdout
}

const hostDirExists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

const REPO_TTL = 60_000
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

/** Answers `prs:lists`: one query in flight per request; each checkout's repo cached briefly. */
export class PrDashboard {
  private repos = new Map<string, { repo: string | null; at: number }>()
  private inFlight = new Map<string, Promise<PrListsResult>>()

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
      const out = await ghLimiter.run(() => this.run("gh", args, at, req.wsl))
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
}
