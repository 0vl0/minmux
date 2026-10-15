// What each agent session is running (docs/design/AGENT_PROCESSES.md): one `ps` snapshot of every
// process, attributed to the pane whose agent started it: under that agent in the pane's tree (the
// first process down it that minmux's wrapper marked), or, for one that detached, by the
// MINMUX_PANE_ID it inherited.
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

/** `ps -axEww -o pid=,command=` output (environments appended after each command) → pid → its
 *  markers, read from the environment only: with the snapshot's command lines, what follows the
 *  command (text in a command's own arguments is never a mark). */
export function parseMarkers(out: string, snap?: Snapshot): Map<number, Marker> {
  const marks = new Map<number, Marker>()
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const command = snap?.get(Number(m[1]))?.command
    // ps -E prints the command, then the environment. Without its command (a process that
    // started between the two runs) the line can't be split: no marks.
    if (snap && (!command || !m[2]!.startsWith(command))) continue
    const env = command ? m[2]!.slice(command.length) : m[2]!
    const pane = PANE.exec(env)?.[1]
    const agent = AGENT.exec(env)?.[1]
    if (pane || agent)
      marks.set(Number(m[1]), { ...(pane ? { pane } : {}), ...(agent ? { agent } : {}) })
  }
  return marks
}

/** Per pane, the process tree its agents run; and the detached work whose pane runs no agent. */
export function attributeAll(
  snap: Snapshot,
  markers: Map<number, Marker>,
  panes: PaneRoots[],
  uid: number,
  agentNames: ReadonlySet<string>, // the agents' commands (claude, codex, opencode)
  owned: ReadonlySet<string>, // every pane this minmux opened (another instance's never count)
): { rows: Record<string, AgentProc[]>; leftovers: Record<string, AgentProc[]> } {
  const leftovers: Record<string, AgentProc[]> = {}
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
  // A pane whose tree still runs an agent (from the snapshot: hooks may be off, or not yet in).
  const running = new Set<string>()
  for (const pane of panes) {
    result[pane.paneId] = []
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
        if (markers.get(c.pid)?.agent || looksLikeAgent(c, agentNames)) roots.push(c)
        else find(c.pid)
      }
    }
    find(pane.shellPid)
    if (roots.length) running.add(pane.paneId)
    // Agents are never rows (an npm launcher's real binary, an agent an agent started): what they
    // run takes their place, under the outermost agent.
    const notRows = new Set<number>()
    for (const r of roots)
      for (const pid of launchers(r.pid, children, agentNames)) notRows.add(pid)
    const rows: AgentProc[] = []
    for (const a of roots)
      rows.push(...treeRows(a.pid, children, snap, uid, false, false, notRows, agentNames))
    result[pane.paneId] = rows
  }

  // Detached: outside every pane's tree, started by an agent from one of them (its environment
  // says which pane, and that an agent started it: a `tmux` the user ran there isn't listed).
  const detached = (pid: number, pane: string) => {
    const p = snap.get(pid)
    const m = markers.get(pid)
    return !!p && !!m?.agent && m.pane === pane && !inSomePane.has(pid) && p.uid === uid
  }
  // An agent that detached (a claude run inside a tmux started from the pane) still runs: its
  // pane's work isn't left running, and it is never a row (End all must not end it).
  const isAgent = (p: Proc) =>
    looksLikeAgent(p, agentNames) || !!launchers(p.pid, children, agentNames).length
  for (const [pid, m] of markers)
    if (m.pane && detached(pid, m.pane) && isAgent(snap.get(pid)!)) running.add(m.pane)
  for (const [pid, m] of markers) {
    // Another instance's (or another user's) pane is never this one's to list or end.
    if (!m.pane || !owned.has(m.pane) || !detached(pid, m.pane)) continue
    // Under its pane's running agent; else left running.
    const into = running.has(m.pane) ? result : leftovers
    // Only the top of a detached tree: one with a detached ancestor (even through a process whose
    // environment can't be read, an Apple binary) is listed under it.
    const pane = m.pane
    if (ancestors(snap, pid).some((a) => a > 1 && detached(a, pane))) continue
    // A shared daemon an agent happened to start first (a tmux server, ssh's ControlMaster) also
    // holds the user's own work: never listed, so never ended, with everything under it.
    if (sharedDaemon(snap.get(pid)!)) continue
    // A detached agent itself (a claude run inside a tmux started from the pane) isn't a row.
    const self = !isAgent(snap.get(pid)!)
    ;(into[pane] ??= []).push(
      ...treeRows(
        pid,
        children,
        snap,
        uid,
        true,
        self,
        new Set(launchers(pid, children, agentNames)),
        agentNames,
      ),
    )
  }
  return { rows: result, leftovers }
}

const DAEMONS = new Set(["tmux", "screen", "ssh-agent", "gpg-agent", "watchman"])

/** A per-user daemon others share (tmux, an ssh ControlMaster, gpg-agent, a Gradle daemon). */
export function sharedDaemon(p: Proc): boolean {
  if (DAEMONS.has(p.comm)) return true
  if (p.comm === "ssh") return /(^|\s)(-\S*M|-o\s*ControlMaster)/.test(p.command)
  return /\bGradleDaemon\b/.test(p.command)
}

/** An agent by its program, or the script an interpreter runs (`node …/claude-code/cli.js`). */
export function looksLikeAgent(p: Proc, agentNames: ReadonlySet<string>): boolean {
  if (agentNames.has(p.comm)) return true
  // The arguments up to the first path (the script; flags and a `run` before it skipped).
  for (const arg of p.command.trim().split(/\s+/).slice(1)) {
    if (arg.startsWith("-")) continue
    const parts = arg.split("/")
    const name = parts.at(-1)!.replace(/\.[cm]?[jt]s$/, "")
    if (agentNames.has(name)) return true
    // A package's entry point: `claude-code/cli.js`, `codex/bin/codex.js`.
    const pkg = parts.at(/^(cli|index|main)$/.test(name) ? -2 : -1)?.split("-")[0] ?? ""
    if (parts.length > 1 && agentNames.has(pkg)) return true
    if (parts.length > 1 || /\.[cm]?[jt]s$/.test(arg)) return false
  }
  return false
}

/** The unbranched chain from an agent down to its real binary (a shim, a `node` launcher): part
 *  of the agent, never rows. Empty when no agent-named process ends the chain. */
function launchers(
  pid: number,
  children: Map<number, Proc[]>,
  agentNames: ReadonlySet<string>,
): number[] {
  const chain: number[] = []
  let at = pid
  for (let i = 0; i < 4; i++) {
    const kids = (children.get(at) ?? []).filter((c) => c.pid !== at)
    if (kids.length !== 1) return []
    const c = kids[0]!
    if (looksLikeAgent(c, agentNames)) return chain
    chain.push(c.pid)
    at = c.pid
  }
  return []
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
  agentNames: ReadonlySet<string> = new Set(),
): AgentProc[] {
  const rows: AgentProc[] = []
  const isAgent = (p: Proc) => agents.has(p.pid) || looksLikeAgent(p, agentNames)
  // A process with an agent under it (a tmux running a claude, a bash running `codex exec`): ending
  // it would end that agent, so it can't be ended from here.
  const holds = new Map<number, boolean>()
  const holdsAgent = (pid: number): boolean => {
    if (holds.has(pid)) return holds.get(pid)!
    holds.set(pid, false) // a loop isn't followed
    const yes = (children.get(pid) ?? []).some(
      (c) => c.pid !== pid && (isAgent(c) || holdsAgent(c.pid)),
    )
    holds.set(pid, yes)
    return yes
  }
  const add = (p: Proc, depth: number) => {
    // An agent is never a row (an npm launcher and its real binary, an agent it started): what it
    // runs takes its place.
    if (isAgent(p)) {
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
        ...(holdsAgent(p.pid) ? { holdsAgent: true } : {}),
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

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn` output → pid → the TCP ports it listens on. */
export function parseLsof(out: string): Map<number, number[]> {
  const ports = new Map<number, number[]>()
  let pid = 0
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid > 0) {
      const port = Number(/:(\d+)$/.exec(line)?.[1])
      if (!Number.isInteger(port) || port <= 0) continue
      const list = ports.get(pid) ?? []
      if (!list.includes(port)) list.push(port)
      ports.set(pid, list)
    }
  }
  for (const list of ports.values()) list.sort((a, b) => a - b)
  return ports
}
