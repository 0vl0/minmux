// The pull requests dialog's data (docs/design/PR_DASHBOARD.md): one `gh api graphql` query per
// refresh, in the focused pane's environment (host, or its WSL distro). Async and on its own
// IPC channel: nowhere near the PTY → renderer path. The user's own gh login; no token here.
import { execFile } from "node:child_process"
import os from "node:os"
import { promisify } from "node:util"
import { wslArgs } from "./git"
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

const defaultRunner: PrRunner = async (cmd, args, cwd, wsl) => {
  const opts = { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  if (wsl) return (await exec("wsl.exe", wslArgs(wsl.distro, cwd, cmd, args), opts)).stdout
  return (await exec(cmd, args, { ...opts, cwd })).stdout
}

const REPO_TTL = 60_000
const QUERY = PR_QUERY.replace(/\s+/g, " ") // one line: safe through wsl.exe's command line

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

/** Answers `prs:lists`: one query in flight at a time; each checkout's repo cached briefly. */
export class PrDashboard {
  private repos = new Map<string, { repo: string | null; at: number }>()
  private inFlight: Promise<PrListsResult> | null = null

  constructor(
    private readonly run: PrRunner = defaultRunner,
    private readonly now: () => number = Date.now,
  ) {}

  /** The lists for the dialog (a refresh asked while one runs gets that one's answer). */
  lists(req: PrListsRequest): Promise<PrListsResult> {
    this.inFlight ??= this.fetch(req).finally(() => (this.inFlight = null))
    return this.inFlight
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
    const cwd = req.cwd || os.homedir()
    const repo = req.cwd ? await this.repoOf(req.cwd, req.wsl) : null
    const s = prSearches(repo ?? undefined, req.closed, this.now())
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `n=${PER_TAB}`]
    args.push("-f", `mine=${s.mine}`, "-f", `review=${s.review}`, "-f", `repo=${s.repo}`)
    args.push("-F", `withRepo=${repo ? "true" : "false"}`)
    try {
      const out = await this.run("gh", args, cwd, req.wsl)
      const lists = parsePrLists(out, !!repo)
      if (!lists) return { ok: false, error: "failed", message: "Unexpected answer from gh" }
      if (repo) lists.repoName = repo
      return { ok: true, lists }
    } catch (e) {
      return { ok: false, ...ghError(e) }
    }
  }
}
