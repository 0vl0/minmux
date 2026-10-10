// Where a pane's agent works besides `from` / `in` (docs/design/AGENT_EDITED_CHECKOUTS.md §2–4):
// the folders its edits and `cd <abs> &&` calls name, grouped by checkout, ranked, and the
// lookups that place them. Pure — the store keeps the state, app.tsx polls, the sidebar shows.

import { agentOf, type AgentEvent, type AgentGraph, type AgentKind } from "./agent-graph"
import { agentInfo } from "./agent-kinds"
import { gitKey, pathKey, samePath } from "./agent-dirs"
import type { PaneGitInfo, PaneGitRequest } from "./pane-git"
import type { Session } from "../types"
import { wslContext } from "./wsl"

/** How often one folder was worked in, and when last (a store-wide sequence number). */
export interface WorkFolder {
  n: number
  at: number
}

/** A pane's work folders, for its lead session; outlives the session (the pane's lifetime). */
export interface PaneWork {
  session: string // the session they're from: a new one working somewhere starts over
  agent: AgentKind
  dirs: Record<string, WorkFolder> // insertion order = recency (the oldest go first)
  shown?: string // the checkout root the `edits` line shows (kept: hysteresis)
  more: string[] // the other checkouts worked in, ranked (the `+N`)
}

/** What a folder's lookup said: its checkout's root (null: not in one), and the folder's own
 *  spelling of that root (`top`), so folders below it are placed without a lookup. */
export interface DirRoot {
  root: string | null
  top?: string
  at: number // ms: a rootless answer is asked again after ROOTLESS_TTL (a `git init` later)
}

export const MAX_DIRS = 64 // folders per pane
export const MAX_ROOTS = 8 // checkouts per pane (one repo may have many folders)
export const MAX_DIR_ROOTS = 512 // folder → root answers kept (the oldest go first)
export const ROOTLESS_TTL = 60_000
export const MAX_RESOLVES = 2 // folder → root lookups per poll, across panes
export const EDIT_EVERY = 30_000 // the shown checkout's branch / PR lookup
const LEAD_BY = 2 // a challenger must lead the shown checkout by this many to replace it

/** Fold an event's work folders into its pane's record: the same reference when it names none. */
export function addWork(
  cur: PaneWork | undefined,
  ev: AgentEvent,
  seq: number,
): PaneWork | undefined {
  if (!ev.worked?.length) return cur
  const fresh = !cur || cur.session !== ev.sessionId
  const dirs = fresh ? {} : { ...cur.dirs }
  for (const d of ev.worked) {
    const n = (dirs[d]?.n ?? 0) + 1
    delete dirs[d] // re-inserted last: the most recent
    dirs[d] = { n, at: seq }
  }
  const keys = Object.keys(dirs)
  for (let i = 0; i < keys.length - MAX_DIRS; i++) delete dirs[keys[i]!]
  return fresh ? { session: ev.sessionId, agent: agentOf(ev), dirs, more: [] } : { ...cur, dirs }
}

/** The pane an event's work belongs to: its session's, when that session leads the pane (not a
 *  background agent, nor an older session); sub-agents' work is their session's. */
export function workPane(graph: AgentGraph, ev: AgentEvent): string | undefined {
  const node = graph.nodes[`root:${ev.sessionId}`]
  const paneId = node?.paneId
  if (!node || !paneId || node.nested) return undefined
  for (const rid of graph.rootIds) {
    const o = graph.nodes[rid]
    if (
      o &&
      o !== node &&
      o.paneId === paneId &&
      !o.nested &&
      (o.started ?? 0) > (node.started ?? 0)
    )
      return undefined
  }
  return paneId
}

/** Record lookups (folder → its answer; undefined: the lookup failed, asked again later). */
export function setDirRoots(
  cur: Record<string, DirRoot>,
  answers: Record<string, PaneGitInfo | undefined>,
  now: number,
): Record<string, DirRoot> {
  const next = { ...cur }
  for (const [dir, info] of Object.entries(answers)) {
    delete next[dir]
    const root = info?.root ?? null
    const top = root && info?.prefix !== undefined ? topOf(dir, info.prefix) : undefined
    next[dir] = top !== undefined ? { root, top, at: now } : { root, at: now }
  }
  const keys = Object.keys(next)
  for (let i = 0; i < keys.length - MAX_DIR_ROOTS; i++) delete next[keys[i]!]
  return next
}

/** A checkout that's gone (a removed worktree): its folders are looked up again. */
export function forgetRoot(cur: Record<string, DirRoot>, root: string): Record<string, DirRoot> {
  const gone = Object.keys(cur).filter((d) => cur[d]!.root === root)
  if (!gone.length) return cur
  const next = { ...cur }
  for (const d of gone) delete next[d]
  return next
}

// The folder minus git's place of it in the repo ("" = the root): the folder's spelling of the
// root. Undefined when they don't line up (a symlink inside the repo).
function topOf(dir: string, prefix: string): string | undefined {
  if (!prefix) return dir
  const k = pathKey(dir)
  return k.endsWith(`/${prefix}`) ? dir.slice(0, dir.length - prefix.length - 1) : undefined
}

const topsMemo = new WeakMap<Record<string, DirRoot>, Map<string, string>>()

// Spelled roots → root, for placing a folder by its ancestors.
function tops(roots: Record<string, DirRoot>): Map<string, string> {
  const hit = topsMemo.get(roots)
  if (hit) return hit
  const out = new Map<string, string>()
  for (const r of Object.values(roots)) if (r.root && r.top) out.set(pathKey(r.top), r.root)
  topsMemo.set(roots, out)
  return out
}

/** A folder's checkout root: known (null: not in one), or undefined (needs a lookup). A folder
 *  inside a known root is placed by its path — unless an agent's worktree folder lies between. */
export function rootOf(
  dir: string,
  roots: Record<string, DirRoot>,
  agent: AgentKind,
  now: number,
): string | null | undefined {
  const hit = roots[dir]
  if (hit) return hit.root !== null || now - hit.at < ROOTLESS_TTL ? hit.root : undefined
  const k = pathKey(dir)
  const known = tops(roots)
  // The folder itself, then each folder above it.
  for (let i = k.length; i > 0; i = k.lastIndexOf("/", i - 1)) {
    const root = known.get(k.slice(0, i))
    if (root === undefined) continue
    const rest = k.slice(i) + "/"
    return agentInfo(agent).worktreeMarkers.some((m) => rest.includes(m)) ? undefined : root
  }
  return undefined
}

/** The checkouts a pane worked in, most work first (ties: the most recent). */
export function rankRoots(
  work: PaneWork,
  roots: Record<string, DirRoot>,
  now: number,
): { root: string; n: number; at: number }[] {
  const by = new Map<string, { root: string; n: number; at: number }>()
  for (const [d, f] of Object.entries(work.dirs)) {
    const root = rootOf(d, roots, work.agent, now)
    if (!root) continue
    const e = by.get(root)
    if (e) {
      e.n += f.n
      e.at = Math.max(e.at, f.at)
    } else by.set(root, { root, n: f.n, at: f.at })
  }
  return [...by.values()].sort((a, b) => b.n - a.n || b.at - a.at)
}

/** Which checkout the pane's `edits` line shows (not `from`'s or `in`'s), and the others. The
 *  shown one changes only when another leads it by LEAD_BY: no flicker. Same reference when
 *  nothing changed. */
export function settleWork(
  work: PaneWork,
  roots: Record<string, DirRoot>,
  exclude: string[],
  now: number,
): PaneWork {
  const ranked = rankRoots(work, roots, now)
    .filter((r) => !exclude.some((x) => samePath(x, r.root)))
    .slice(0, MAX_ROOTS)
  const prev = ranked.find((r) => r.root === work.shown)
  const top = ranked[0]
  const shown = prev && top && top.n < prev.n + LEAD_BY ? prev.root : top?.root
  const more = ranked.map((r) => r.root).filter((r) => r !== shown)
  if (shown === work.shown && more.join("\n") === work.more.join("\n")) return work
  return { ...work, shown, more }
}

/** settleWork for every pane, excluding each one's `from` / `in` checkouts; same reference when
 *  nothing changed. */
export function settleAllWork(
  paneWork: Record<string, PaneWork>,
  roots: Record<string, DirRoot>,
  paneGit: Record<string, PaneGitInfo>,
  now: number,
): Record<string, PaneWork> {
  let next: Record<string, PaneWork> | null = null
  for (const [p, w] of Object.entries(paneWork)) {
    const exclude = [paneGit[p]?.root, paneGit[gitKey(p, "in")]?.root].filter(
      (r): r is string => !!r,
    )
    const s = settleWork(w, roots, exclude, now)
    if (s === w) continue
    next ??= { ...paneWork }
    next[p] = s
  }
  return next ?? paneWork
}

/** Folders still to place, most-worked first, at most `max` across panes. */
export function toResolve(
  paneWork: Record<string, PaneWork>,
  roots: Record<string, DirRoot>,
  now: number,
  max = MAX_RESOLVES,
): { paneId: string; dir: string }[] {
  const out: { paneId: string; dir: string }[] = []
  const seen = new Set<string>()
  for (const [paneId, w] of Object.entries(paneWork)) {
    const dirs = Object.entries(w.dirs).sort((a, b) => b[1].n - a[1].n || b[1].at - a[1].at)
    for (const [dir] of dirs) {
      if (out.length >= max) return out
      if (seen.has(dir) || rootOf(dir, roots, w.agent, now) !== undefined) continue
      seen.add(dir)
      out.push({ paneId, dir })
    }
  }
  return out
}

/** The `edits` poll: each pane's shown checkout (when due), plus a few folders to place. Panes
 *  with nothing shown clear their answer. Separate from the `from` / `in` poll: never delays it. */
export function planEditPoll(
  sessions: Pick<Session, "id" | "command" | "args">[],
  paneWork: Record<string, PaneWork>,
  roots: Record<string, DirRoot>,
  last: ReadonlyMap<string, { root: string; at: number }>, // edit key → its last lookup
  now: number,
): {
  reqs: PaneGitRequest[]
  polled: string[]
  editCwd: Record<string, string> // edit key → the root asked for
  resolves: Record<string, string> // request key → the folder to place
} {
  const reqs: PaneGitRequest[] = []
  const polled: string[] = []
  const editCwd: Record<string, string> = {}
  const resolves: Record<string, string> = {}
  const byId = new Map(sessions.map((x) => [x.id, x]))
  for (const x of sessions) {
    const key = gitKey(x.id, "edit")
    const root = paneWork[x.id]?.shown
    if (!root) {
      polled.push(key)
      continue
    }
    const prev = last.get(key)
    if (prev && prev.root === root && now - prev.at < EDIT_EVERY) continue // not due: kept
    if (reqs.length >= 64 - MAX_RESOLVES) continue // main answers ≤ 64
    reqs.push({ paneId: key, cwd: root, wsl: wslContext(x.command, x.args) })
    polled.push(key)
    editCwd[key] = root
  }
  toResolve(paneWork, roots, now).forEach(({ paneId, dir }, i) => {
    const x = byId.get(paneId)
    if (!x) return
    const key = `resolve:${i}`
    reqs.push({ paneId: key, cwd: dir, wsl: wslContext(x.command, x.args), noPr: true })
    resolves[key] = dir
  })
  return { reqs, polled, editCwd, resolves }
}

/** The pane's `+N`: its session's other worktrees and the other checkouts it worked in, once. */
export function moreFolders(worktrees: string[], more: string[], shown?: string): string[] {
  const out: string[] = []
  for (const p of [...worktrees, ...more])
    if (!(shown && samePath(p, shown)) && !out.some((o) => samePath(o, p))) out.push(p)
  return out
}

const flatMemo = new WeakMap<Record<string, PaneWork>, string[]>()

/** Each pane's shown checkout + the others, flat [paneId, agent, shown, more…] (useShallow). */
export function paneWorkFlat(paneWork: Record<string, PaneWork>): string[] {
  const hit = flatMemo.get(paneWork)
  if (hit) return hit
  const out = Object.entries(paneWork).flatMap(([id, w]) => [
    id,
    w.agent,
    w.shown ?? "",
    w.more.join("\n"),
  ])
  flatMemo.set(paneWork, out)
  return out
}
