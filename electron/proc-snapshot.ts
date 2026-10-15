// What each agent session is running (docs/design/AGENT_PROCESSES.md): one `ps` snapshot of every
// process, attributed to the pane whose agent started it, by the process tree (nearest agent
// ancestor under the pane's shell) or, for one that detached, by the MINMUX_PANE_ID it inherited.
// Pure: the sessions worker runs `ps` and feeds the output here.

import type { AgentProc } from "../src/lib/agent-processes"

export interface Proc {
  pid: number
  ppid: number
  uid: number
  cpu: number // %
  rssKb: number
  started: number // ms (ps lstart: second resolution)
  command: string // the full command line
  comm: string // the program's name (its path's last part)
}

export type Snapshot = Map<number, Proc>

/** One pane to attribute processes to: its shell. */
export interface PaneRoots {
  paneId: string
  shellPid: number
}

// ps `lstart` (LC_ALL=C): `Wed Oct 15 09:32:03 2026`.
export const LSTART = "\\w{3} \\w{3}\\s+\\d+ [\\d:]{8} \\d{4}"
// `pid ppid uid %cpu rss <lstart> command…`
const LINE = new RegExp(
  `^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+([\\d.]+)\\s+(\\d+)\\s+(${LSTART})\\s+(.*)$`,
)

/** The program's name: the first word's last path part (`/usr/bin/node x` → `node`). */
export const commOf = (command: string): string => {
  const first = command.trim().split(/\s+/)[0] ?? ""
  return first.slice(first.lastIndexOf("/") + 1)
}

/** `ps -axww -o pid=,ppid=,uid=,pcpu=,rss=,lstart=,command=` output → the snapshot. */
export function parsePs(out: string): Snapshot {
  const snap: Snapshot = new Map()
  for (const line of out.split("\n")) {
    const m = LINE.exec(line)
    if (!m) continue
    const started = Date.parse(m[6]!)
    const command = m[7]!.trim()
    snap.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      uid: Number(m[3]),
      cpu: Number(m[4]),
      rssKb: Number(m[5]),
      started: Number.isFinite(started) ? started : 0,
      command,
      comm: commOf(command),
    })
  }
  return snap
}

const PANE = /(?:^|\s)MINMUX_PANE_ID=([A-Za-z0-9_-]+)(?=\s|$)/
// Set by minmux's agent wrappers on the agent they start: everything the agent runs inherits it,
// nothing the user runs in the pane does.
const AGENT = /(?:^|\s)MINMUX_AGENT=([a-z]+)(?=\s|$)/

/** Where a process came from, as its environment says: its pane, and the agent if one started it. */
export interface Marker {
  pane?: string // MINMUX_PANE_ID
  agent?: string // MINMUX_AGENT
}

/** `ps -axEww -o pid=,command=` output (environments appended) → pid → its markers. */
export function parseMarkers(out: string): Map<number, Marker> {
  const marks = new Map<number, Marker>()
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pane = PANE.exec(m[2]!)?.[1]
    const agent = AGENT.exec(m[2]!)?.[1]
    if (pane || agent)
      marks.set(Number(m[1]), { ...(pane ? { pane } : {}), ...(agent ? { agent } : {}) })
  }
  return marks
}

/** Per pane: the processes its agents run, as a tree (parents first, children indented). */
export function attribute(
  snap: Snapshot,
  markers: Map<number, Marker>,
  panes: PaneRoots[],
  uid: number,
  agentNames: ReadonlySet<string>, // the agents' commands (claude, codex, opencode)
): Record<string, AgentProc[]> {
  const children = new Map<number, Proc[]>()
  for (const p of snap.values()) {
    const list = children.get(p.ppid)
    if (list) list.push(p)
    else children.set(p.ppid, [p])
  }
  const under = (pid: number): Proc[] => {
    const out: Proc[] = []
    const walk = (at: number) => {
      for (const c of children.get(at) ?? []) {
        if (c.pid === at) continue // pid 0's own entry
        out.push(c)
        walk(c.pid)
      }
    }
    walk(pid)
    return out
  }

  const result: Record<string, AgentProc[]> = {}
  const inSomePane = new Set<number>()
  for (const pane of panes) {
    if (!snap.has(pane.shellPid)) continue
    const tree = under(pane.shellPid)
    for (const p of tree) inSomePane.add(p.pid)
    inSomePane.add(pane.shellPid)
    // The agents in this pane: walking down from its shell, the first process on each branch that
    // minmux's wrapper marked (MINMUX_AGENT: set on the agent, inherited by everything below it,
    // never on anything above). Hidden environments only occur below an agent, where the walk has
    // already stopped. A branch with no mark: the first process running an agent's command (one
    // started outside the wrapper). Never a pid remembered from earlier: it may have been reused.
    const roots: Proc[] = []
    const find = (at: number) => {
      for (const c of children.get(at) ?? []) {
        if (c.pid === at) continue
        if (markers.get(c.pid)?.agent || agentNames.has(c.comm)) roots.push(c)
        else find(c.pid)
      }
    }
    find(pane.shellPid)
    // Agents are never rows (an npm launcher's real binary, an agent an agent started): what they
    // run takes their place, under the outermost agent.
    const notRows = new Set([
      ...roots.map((r) => r.pid),
      ...tree.filter((p) => agentNames.has(p.comm)).map((p) => p.pid),
    ])
    const rows: AgentProc[] = []
    for (const a of roots) rows.push(...treeRows(a.pid, children, snap, uid, false, false, notRows))
    result[pane.paneId] = rows
  }

  // Detached: outside every pane's tree, started by an agent from one of them (its environment
  // says which pane, and that an agent started it: a `tmux` the user ran there isn't listed).
  const paneIds = new Set(panes.map((p) => p.paneId))
  const detached = (pid: number, pane: string) => {
    const p = snap.get(pid)
    const m = markers.get(pid)
    return !!p && !!m?.agent && m.pane === pane && !inSomePane.has(pid) && p.uid === uid
  }
  for (const [pid, m] of markers) {
    if (!m.pane || !paneIds.has(m.pane) || !detached(pid, m.pane)) continue
    // Only the top of a detached tree: one with a detached ancestor (even through a process whose
    // environment can't be read, an Apple binary) is listed under it.
    const pane = m.pane
    if (ancestors(snap, pid).some((a) => a > 1 && detached(a, pane))) continue
    ;(result[pane] ??= []).push(...treeRows(pid, children, snap, uid, true, true))
  }
  return result
}

/** A process's ancestors (parent first), stopping at a loop or the root. */
function ancestors(snap: Snapshot, pid: number): number[] {
  const out: number[] = []
  const seen = new Set<number>([pid])
  for (let at = snap.get(pid)?.ppid; at && !seen.has(at); at = snap.get(at)?.ppid) {
    out.push(at)
    seen.add(at)
  }
  return out
}

/** `pid`'s descendants (or `pid` and them, `self`) as rows, depth-first; only the user's own. */
function treeRows(
  pid: number,
  children: Map<number, Proc[]>,
  snap: Snapshot,
  uid: number,
  detached: boolean,
  self = false,
  agents: ReadonlySet<number> = new Set(),
): AgentProc[] {
  const rows: AgentProc[] = []
  const add = (p: Proc, depth: number) => {
    // An agent is never a row (an npm shim's real binary, an agent it started): what it runs
    // takes its place.
    if (agents.has(p.pid)) {
      for (const c of children.get(p.pid) ?? []) if (c.pid !== p.pid) add(c, depth)
      return
    }
    if (p.uid === uid)
      rows.push({
        pid: p.pid,
        ppid: p.ppid,
        command: p.command,
        comm: p.comm,
        cpu: p.cpu,
        rssKb: p.rssKb,
        started: p.started,
        depth,
        ...(detached ? { detached: true } : {}),
      })
    for (const c of children.get(p.pid) ?? []) if (c.pid !== p.pid) add(c, depth + 1)
  }
  const top = snap.get(pid)
  if (!top) return rows
  if (self) add(top, 0)
  else for (const c of children.get(pid) ?? []) add(c, 0)
  return rows
}

/** Which processes to signal to end `pid` and everything under it: deepest first, then it, each
 *  with its start (a second pass signals only the same processes). */
export function killOrder(snap: Snapshot, pid: number): { pid: number; started: number }[] {
  const children = new Map<number, number[]>()
  for (const p of snap.values()) {
    if (p.pid === p.ppid) continue
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  const out: { pid: number; started: number }[] = []
  const seen = new Set<number>()
  const walk = (at: number) => {
    if (seen.has(at)) return
    seen.add(at)
    for (const c of children.get(at) ?? []) walk(c)
    out.push({ pid: at, started: snap.get(at)!.started })
  }
  if (snap.has(pid)) walk(pid)
  return out
}

/** Of these processes, the ones still running as the same process (same start, from `starts`). */
export const stillRunning = (
  starts: ReadonlyMap<number, number>,
  procs: { pid: number; started: number }[],
): { pid: number; started: number }[] =>
  procs.filter((p) => {
    const at = starts.get(p.pid)
    return at !== undefined && Math.abs(at - p.started) <= 1000
  })
