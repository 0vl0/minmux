import { describe, expect, it } from "vitest"
import { emptyGraph, reduceAgentEvent, type AgentEvent } from "./agent-graph"
import type { PaneGitInfo } from "./pane-git"
import { herePr, prPanes } from "./pr-panes"

const graphOf = (events: AgentEvent[]) => events.reduce(reduceAgentEvent, emptyGraph)
// an agent in pane p1, working (a prompt sent) in `cwd`
const agentIn = (cwd: string, pane = "p1") =>
  graphOf([
    { agent: "claude", event: "SessionStart", sessionId: `s-${pane}`, paneId: pane, cwd },
    { agent: "claude", event: "UserPromptSubmit", sessionId: `s-${pane}`, paneId: pane, cwd },
  ])
const git = (root: string, pr?: number, forCwd?: string): PaneGitInfo => ({
  root,
  ...(forCwd ? { forCwd } : {}),
  ...(pr ? { pr: { number: pr, state: "open", url: `u${pr}` } } : {}),
})

describe("prPanes / herePr", () => {
  it("the agent in the shell's checkout: on the shell's PR", () => {
    const g = agentIn("/w/app/src")
    const paneGit = { p1: git("/w/app", 10, "/w/app") }
    const out = prPanes(g, paneGit, [{ id: "p1", cwd: "/w/app" }])
    expect(out.get("u10")).toEqual([{ pane: "p1", agent: "claude", status: "working" }])
    expect(herePr(g, paneGit, { id: "p1", cwd: "/w/app" })).toBe("u10")
  })

  it("the agent working in another checkout: on that one's PR; the shell's is a plain terminal", () => {
    const g = agentIn("/w/other")
    const paneGit = { p1: git("/w/app", 10, "/w/app"), "p1@in": git("/w/other", 11, "/w/other") }
    const out = prPanes(g, paneGit, [{ id: "p1", cwd: "/w/app" }])
    expect(out.get("u10")).toEqual([{ pane: "p1" }])
    expect(out.get("u11")).toEqual([{ pane: "p1", agent: "claude", status: "working" }])
    expect(herePr(g, paneGit, { id: "p1", cwd: "/w/app" })).toBe("u11")
  })

  it("an `edit` checkout (the last other repo it touched) is never where it works", () => {
    const g = agentIn("/w/app")
    const paneGit = {
      p1: git("/w/app", 10, "/w/app"),
      "p1@edit": git("/w/dotfiles", 12, "/w/dotfiles"),
    }
    const out = prPanes(g, paneGit, [{ id: "p1", cwd: "/w/app" }])
    expect(out.get("u10")).toEqual([{ pane: "p1", agent: "claude", status: "working" }])
    expect(out.get("u12")).toBeUndefined()
  })

  it("a previous session's `in` answer doesn't apply to the agent here now", () => {
    const g = agentIn("/w/app") // the new session works in the shell's checkout
    const paneGit = { p1: git("/w/app", 10, "/w/app"), "p1@in": git("/w/old", 11, "/w/old") }
    const out = prPanes(g, paneGit, [{ id: "p1", cwd: "/w/app" }])
    expect(out.get("u10")).toEqual([{ pane: "p1", agent: "claude", status: "working" }])
    expect(out.get("u11")).toBeUndefined()
  })

  it("no agent: a plain terminal on the shell's PR; the busiest pane first", () => {
    const g = graphOf([
      { agent: "codex", event: "SessionStart", sessionId: "s2", paneId: "p2", cwd: "/w/app" },
      {
        agent: "codex",
        event: "Notification",
        sessionId: "s2",
        paneId: "p2",
        cwd: "/w/app",
        message: "needs approval",
      },
    ])
    const paneGit = { p1: git("/w/app", 10, "/w/app"), p2: git("/w/app", 10, "/w/app") }
    const out = prPanes(g, paneGit, [
      { id: "p1", cwd: "/w/app" },
      { id: "p2", cwd: "/w/app" },
    ])
    expect(out.get("u10")!.map((x) => [x.pane, x.agent])).toEqual([
      ["p2", "codex"],
      ["p1", undefined],
    ])
  })
})
