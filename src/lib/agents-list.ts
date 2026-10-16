// The agents panel's one list (docs/design/AGENTS_PANEL.md): the sessions in open panes grouped
// like the sidebar (one group per tab, the current one first), then every other past session.
// Pure: the panel passes the board, the tabs and the Sessions listing.

import type { AgentGraph, AgentKind, AgentNode } from "./agent-graph"
import type { PastSession } from "./past-sessions"
import { allSessionIds } from "./pane-tree"
import type { Tab } from "../types"

/** A session in an open pane: the board's root for it, and its past-sessions entry if listed. */
export interface ActiveRow {
  key: string // agent:sessionId
  agent: AgentKind
  sessionId: string
  paneId: string
  cwd?: string
  node?: AgentNode // the board's root (absent: ended there, or a resume not started yet)
  past?: PastSession
  running: boolean // its agent still runs there (else ended: dimmed, a click resumes it)
}

export interface ActiveGroup {
  id: string // the tab's id, or ELSEWHERE
  tabId?: string
  current: boolean // the tab you're in
  rows: ActiveRow[]
}

/** Sessions the board knows whose pane isn't open in a tab (`external` today). */
export const ELSEWHERE = "elsewhere"

const key = (agent: AgentKind, sessionId: string) => `${agent}:${sessionId}`

/** The listing by row key (agent:sessionId), built once per listing. */
export const pastIndex = (past: PastSession[]): ReadonlyMap<string, PastSession> =>
  new Map(past.map((s) => [key(s.agent, s.sessionId), s]))

// Walks the board's sessions and the open panes only (a handful), never the whole listing:
// it runs on every hook event. `open` maps a row key to the pane it's open in (openPaneMap).
/** The groups of active sessions, and their keys. */
export function activeGroups(o: {
  graph: AgentGraph
  tabs: Tab[]
  activeTabId: string
  past: ReadonlyMap<string, PastSession> // the filtered listing (pastIndex)
  open: ReadonlyMap<string, string>
  shows: (agent: AgentKind, cwd?: string) => boolean
}): { groups: ActiveGroup[]; keys: ReadonlySet<string> } {
  const tabOf = new Map<string, string>()
  for (const t of o.tabs) for (const id of allSessionIds(t.root)) tabOf.set(id, t.id)

  const rows: ActiveRow[] = []
  const elsewhere: ActiveRow[] = []
  const seen = new Set<string>()
  for (const rid of o.graph.rootIds) {
    const node = o.graph.nodes[rid]
    if (!node || !o.shows(node.agent, node.cwd)) continue
    const k = key(node.agent, node.sessionId)
    seen.add(k)
    const row: ActiveRow = {
      key: k,
      agent: node.agent,
      sessionId: node.sessionId,
      paneId: node.paneId ?? "",
      cwd: node.cwd,
      node,
      past: o.past.get(k),
      running: node.status !== "done",
    }
    if (node.paneId && tabOf.has(node.paneId)) rows.push(row)
    else if (row.running)
      elsewhere.push({ ...row, paneId: "" }) // its pane closed (or none): nowhere to go
    else seen.delete(k)
  }
  // A listed session open in a pane the board hasn't started yet (a resume on its way). One the
  // board knows was decided above (a filter may have left it out: it stays out).
  for (const [k, pane] of o.open) {
    const s = o.past.get(k)
    if (!s || seen.has(k) || !tabOf.has(pane)) continue
    if (o.graph.nodes[`root:${s.sessionId}`]?.agent === s.agent) continue
    seen.add(k)
    rows.push({
      key: k,
      agent: s.agent,
      sessionId: s.sessionId,
      paneId: pane,
      cwd: s.cwd,
      past: s,
      running: true,
    })
  }
  // Ended in a pane that's still open (newest first): dimmed in its group, a click resumes it.
  for (const e of o.graph.ended ?? []) {
    const k = key(e.agent, e.sessionId)
    if (seen.has(k) || !tabOf.has(e.paneId) || !o.shows(e.agent, e.cwd)) continue
    seen.add(k)
    rows.push({
      key: k,
      agent: e.agent,
      sessionId: e.sessionId,
      paneId: e.paneId,
      cwd: e.cwd,
      past: o.past.get(k),
      running: false,
    })
  }

  // Running first, in the board's order; then ended, newest first (by when it was last written,
  // else as they ended).
  const order = (a: ActiveRow, b: ActiveRow) =>
    a.running !== b.running
      ? a.running
        ? -1
        : 1
      : a.running
        ? 0
        : (b.past?.updatedAt ?? 0) - (a.past?.updatedAt ?? 0)
  const byTab = new Map<string, ActiveRow[]>()
  for (const r of rows) {
    const t = tabOf.get(r.paneId)!
    const list = byTab.get(t)
    if (list) list.push(r)
    else byTab.set(t, [r])
  }
  const tabOrder = [
    ...o.tabs.filter((t) => t.id === o.activeTabId),
    ...o.tabs.filter((t) => t.id !== o.activeTabId),
  ]
  const groups: ActiveGroup[] = tabOrder.flatMap((t) => {
    const list = byTab.get(t.id)
    return list
      ? [{ id: t.id, tabId: t.id, current: t.id === o.activeTabId, rows: list.sort(order) }]
      : []
  })
  if (elsewhere.length) groups.push({ id: ELSEWHERE, current: false, rows: elsewhere })
  return { groups, keys: seen }
}

// The one pass over the listing: recompute it only when it, the open panes or the active change.
/** The listed sessions neither open in a pane nor active, newest first. */
export const inactiveOf = (
  past: PastSession[],
  open: ReadonlyMap<string, string>,
  active: ReadonlySet<string>,
): PastSession[] =>
  past.filter((s) => {
    const k = key(s.agent, s.sessionId)
    return !open.has(k) && !active.has(k)
  })
