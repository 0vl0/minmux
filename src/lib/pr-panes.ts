// Which PRs each pane is on, and which one its agent works on: the pull requests dialog's
// "working on it" / "here". The sidebar's own rule, never a second one: the agent works in its
// pane's shell checkout unless it works in another checkout (worksElsewhere, its `in` answer
// checked against the agent's folder by inGitFor: a previous session's answer never applies).
// The `edit` checkout (the last other repo it touched) is never where it works; it's listed
// as checked out there, with no agent, as the sidebar lists it. Pure.
import { agentWorkDirs, gitKey, inGitFor, worksElsewhere } from "./agent-dirs"
import { paneLeads, type AgentGraph, type AgentKind, type AgentStatus } from "./agent-graph"
import type { PaneGitInfo } from "./pane-git"

/** A pane a PR is checked out in, and the agent working on it there (none: a plain terminal). */
export interface PrPane {
  pane: string
  agent?: AgentKind
  status?: AgentStatus
}

/** A live pane: its id and its shell's folder. */
export type PaneAt = { id: string; cwd?: string }

/** A pane's PRs: its shell's, and its agent's (with the agent) when that's another checkout. */
function paneOn(graph: AgentGraph, paneGit: Record<string, PaneGitInfo>, p: PaneAt) {
  const shell = paneGit[p.id]?.pr?.url
  const lead = paneLeads(graph)[p.id]
  if (!lead) return { shell }
  const agent = { agent: lead.agent, status: lead.status }
  const dir = agentWorkDirs(graph)[p.id]
  const inGit = paneGit[gitKey(p.id, "in")]
  if (!dir || !worksElsewhere(p.cwd, dir.cwd, paneGit[p.id], inGit, dir.agent))
    return { shell, agent, agentOnShell: true }
  return { shell, agent, agentPr: inGitFor(inGit, dir.cwd, dir.agent)?.pr?.url }
}

/** Each PR url → the panes it's checked out in, with the agent working on it in each
 *  (agents waiting first, then working, then idle; plain terminals last). */
export function prPanes(
  graph: AgentGraph,
  paneGit: Record<string, PaneGitInfo>,
  panes: PaneAt[],
): Map<string, PrPane[]> {
  const out = new Map<string, PrPane[]>()
  const add = (url: string | undefined, entry: PrPane) => {
    if (!url) return
    const list = out.get(url) ?? []
    const had = list.find((x) => x.pane === entry.pane)
    if (!had) list.push(entry)
    else if (!had.agent && entry.agent) Object.assign(had, entry) // (a second clone, same PR)
    out.set(url, list)
  }
  for (const p of panes) {
    const on = paneOn(graph, paneGit, p)
    add(on.shell, { pane: p.id, ...(on.agentOnShell ? on.agent : {}) })
    if (!on.agentOnShell && on.agent) add(on.agentPr, { pane: p.id, ...on.agent })
    // the checkout its agent edits in: checked out there too (as the sidebar lists it), no agent
    if (on.agent) add(paneGit[gitKey(p.id, "edit")]?.pr?.url, { pane: p.id })
  }
  const rank = (x: PrPane) =>
    x.status === "waiting" ? 0 : x.status === "working" ? 1 : x.agent ? 2 : 3
  for (const list of out.values()) list.sort((a, b) => rank(a) - rank(b))
  return out
}

/** The PR a pane is on: its agent's when the agent works in another checkout that has one,
 *  else its shell's. */
export function herePr(
  graph: AgentGraph,
  paneGit: Record<string, PaneGitInfo>,
  pane: PaneAt | undefined,
): string | undefined {
  if (!pane) return undefined
  const on = paneOn(graph, paneGit, pane)
  return on.agentPr ?? on.shell
}
