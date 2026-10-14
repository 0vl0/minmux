// How an agent's status shows: a dot (App.css .dot.*) and a short word. Shared by the agents
// panel and the pull requests dialog (which drops `pulse`: no animation over the panes).
import type { AgentStatus } from "./agent-graph"

export const AGENT_STATUS_UI: Record<AgentStatus, { cls: string; word: string }> = {
  working: { cls: "accent pulse", word: "working" },
  waiting: { cls: "amber", word: "needs input" },
  idle: { cls: "faint", word: "idle" },
  done: { cls: "blue", word: "done" },
}

/** The same, never animated (over the terminal panes: the pull requests dialog). */
export const AGENT_STATUS_STILL: Record<AgentStatus, { cls: string; word: string }> = {
  ...AGENT_STATUS_UI,
  working: { cls: "accent", word: "working" },
}
