import { GitBranch } from "@phosphor-icons/react"
import { isInside, samePath } from "../lib/agent-dirs"
import { formatTokens, tokenBreakdown } from "../lib/tokens"
import { subAgents, type AgentGraph, type AgentNode } from "../lib/agent-graph"
import { AGENT_STATUS_UI as DOT } from "../lib/agent-status-ui"

const base = (p?: string) => (p ? (p.replace(/\/+$/, "").split(/[\\/]/).pop() ?? p) : "")

// Tree connector class for a row hanging off the spine: every child carries a through-line
// except the last, which ends the spine with an elbow only. Shared by sub-agents + worktrees.
const treeChildClass = (isLast: boolean) => `tree-child${isLast ? "" : " through"}`

export function AgentRow({
  node,
  depth,
  rootCwd,
  onFocusPane,
  onOpen,
  spine,
  connect,
}: {
  node: AgentNode
  depth: number
  rootCwd?: string // the session root's cwd, so a sub-agent only shows its folder when it differs
  onFocusPane?: () => void
  onOpen: (cwd: string) => void
  spine?: boolean // root with children → drop the tree spine down to the first child
  connect?: "through" | "end" // child row: draw the elbow (+ through-line unless it's the last)
}) {
  const d = DOT[node.status]
  const isRoot = node.agentType === "root"
  const primary = isRoot ? "session" : node.agentType
  // Child rows: the elbow leaves from the parent's dot (the root's spine is at 13px).
  const treeX = { "--tree-x": `${13 + Math.max(0, depth - 1) * 16}px` } as React.CSSProperties
  const cls =
    "diff-file" +
    (spine ? " tree-parent" : "") +
    (connect ? ` ${treeChildClass(connect === "end")}` : "")
  // The folder this row's subline represents (clickable → open a terminal there). Root: its
  // cwd. Sub-agent: only when its cwd differs from the root (e.g. a worktree) — otherwise the
  // subline keeps the more useful recent-file / last-message signal (the root's folder, shown
  // right above, already covers the shared cwd).
  const folderLink = isRoot ? node.cwd : node.cwd && node.cwd !== rootCwd ? node.cwd : undefined
  const sub = folderLink
    ? base(folderLink)
    : (node.recentFiles[0] ? base(node.recentFiles[0]) : node.lastMessage?.slice(0, 40)) || "—"
  return (
    <div
      className={cls}
      style={{
        ...treeX,
        paddingLeft: 10 + depth * 16,
        cursor: onFocusPane ? "pointer" : undefined,
      }}
      onMouseDown={onFocusPane}
      title={onFocusPane ? "Go to this pane" : undefined}
    >
      <span className={`dot ${d.cls}`} />
      <div className="tree-labels">
        <span className="tree-primary">
          {primary}
          {node.currentTool && <span className="status-faint"> · {node.currentTool}</span>}
        </span>
        {folderLink ? (
          // The folder is the affordance: a real button (keyboard-focusable) styled as
          // inline text — hover/focus underlines it, click/Enter opens a terminal there.
          <button
            className="tree-sub folder-link"
            title={`Open a terminal here — ${folderLink}`}
            onMouseDown={(e) => e.stopPropagation()} // don't also focus the source pane
            onClick={() => onOpen(folderLink)}
          >
            {sub}
          </button>
        ) : (
          <span className="tree-sub">{sub}</span>
        )}
      </div>
      <div className="tree-right">
        <span className="status-faint">{d.word}</span>
        {node.tokens && (node.tokens.context > 0 || node.tokens.output > 0) && (
          <span className="tree-tokens" title={tokenBreakdown(node.tokens)}>
            ↑{formatTokens(node.tokens.context)} ↓{formatTokens(node.tokens.output)}
          </span>
        )}
      </div>
    </div>
  )
}

/** A session's tree on the board: its root, sub-agents and worktrees, with the spine joining them
 *  (an expanded row in the agents list). */
export function AgentTree({
  graph,
  root,
  onFocusPane,
  onOpen,
}: {
  graph: AgentGraph
  root: AgentNode
  onFocusPane?: () => void
  onOpen: (cwd: string) => void
}) {
  // Tree connectors: children then worktrees hang off the root. Only the very last row ends the
  // spine (rounded elbow, no through-line).
  const childNodes = subAgents(graph, root)
  const wts = root.worktrees ?? []
  // The worktree the agent is in: the deepest containing its cwd (worktrees can nest).
  const inWt = wts
    .filter((w) => root.cwd && (samePath(root.cwd, w.path) || isInside(root.cwd, w.path)))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path
  const hasKids = childNodes.length > 0 || wts.length > 0
  // The root's spine runs on past a row while a direct child or a worktree follows.
  const lastDirect = wts.length
    ? childNodes.length
    : childNodes.reduce((at, k, n) => (k.depth === 1 ? n : at), -1)
  return (
    <>
      {/* The root only as the spine's anchor: the session's own line already shows it. */}
      {hasKids && (
        <AgentRow node={root} depth={0} onFocusPane={onFocusPane} onOpen={onOpen} spine />
      )}
      {childNodes.map(({ node: child, depth }, i) => (
        <AgentRow
          key={child.id}
          node={child}
          depth={depth}
          rootCwd={root.cwd}
          onFocusPane={onFocusPane}
          onOpen={onOpen}
          connect={i >= lastDirect ? "end" : "through"}
        />
      ))}
      {wts.map((w, j) => (
        <div
          key={w.path}
          className={`diff-file agent-worktree ${treeChildClass(j === wts.length - 1)}`}
          style={{ paddingLeft: 26 }}
        >
          <GitBranch size={12} color="var(--blue)" />
          <div className="tree-labels">
            <span className="tree-primary">
              {w.branch ?? base(w.path)}
              {/* The agent works in this one now — the sidebar's `in` line. */}
              {w.path === inWt && <span className="status-faint"> · in</span>}
            </span>
            <button
              className="tree-sub folder-link"
              title={`Open a terminal here — ${w.path}`}
              onClick={() => onOpen(w.path)}
            >
              {base(w.path)}
            </button>
          </div>
        </div>
      ))}
    </>
  )
}
