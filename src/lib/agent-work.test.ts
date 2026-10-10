import { describe, expect, it } from "vitest"
import { reduceAgentEvents, type AgentEvent } from "./agent-graph"
import {
  addWork,
  EDIT_EVERY,
  forgetRoot,
  MAX_DIRS,
  moreFolders,
  paneWorkFlat,
  planEditPoll,
  rootOf,
  ROOTLESS_TTL,
  RETRY_MS,
  needsLookup,
  keepDirRoots,
  setDirRoots,
  settleAllWork,
  settleWork,
  toResolve,
  workPane,
  type PaneWork,
} from "./agent-work"
import { gitKey, paneOfGitKey, settleInAnswers, tagShellAnswers } from "./agent-dirs"

const ev = (worked: string[] | undefined, sessionId = "s1", more: Partial<AgentEvent> = {}) =>
  ({ event: "PostToolUse", sessionId, paneId: "p1", worked, ...more }) as AgentEvent

/** Work in folders, `n` times each, in order (the last is the most recent). */
function work(...dirs: [string, number][]): PaneWork {
  let w: PaneWork | undefined
  let seq = 0
  for (const [d, n] of dirs) for (let i = 0; i < n; i++) w = addWork(w, ev([d]), ++seq, 0)
  return w!
}

const repo = (root: string, prefix = "") => ({ root, prefix, branch: "b" })

describe("addWork", () => {
  it("counts each folder; the same reference when an event names none", () => {
    const w = addWork(undefined, ev(["/a", "/b"]), 1, 0)!
    expect(w.dirs).toEqual({ "/a": { n: 1, at: 1, t: 0 }, "/b": { n: 1, at: 1, t: 0 } })
    const w2 = addWork(w, ev(["/a"]), 2, 5)!
    expect(w2.dirs["/a"]).toEqual({ n: 2, at: 2, t: 5 })
    expect(Object.keys(w2.dirs)).toEqual(["/b", "/a"]) // most recent last
    expect(addWork(w2, ev(undefined), 3, 0)).toBe(w2)
    expect(addWork(undefined, ev([]), 3, 0)).toBeUndefined()
  })

  it("a new session working somewhere starts over", () => {
    const w = addWork(addWork(undefined, ev(["/a"]), 1, 0), ev(["/b"], "s2"), 2, 0)!
    expect(w.session).toBe("s2")
    expect(Object.keys(w.dirs)).toEqual(["/b"])
  })

  it("keeps the most recent MAX_DIRS folders", () => {
    let w: PaneWork | undefined
    for (let i = 0; i < MAX_DIRS + 5; i++) w = addWork(w, ev([`/d${i}`]), i, 0)
    expect(Object.keys(w!.dirs)).toHaveLength(MAX_DIRS)
    expect(w!.dirs["/d0"]).toBeUndefined()
    expect(w!.dirs[`/d${MAX_DIRS + 4}`]).toBeDefined()
  })
})

describe("workPane", () => {
  const start = (sessionId: string, more: Partial<AgentEvent> = {}): AgentEvent => ({
    event: "SessionStart",
    sessionId,
    paneId: "p1",
    cwd: "/r",
    ...more,
  })

  it("the lead session's work (and its sub-agents') is the pane's", () => {
    const g = reduceAgentEvents([start("s1")])
    expect(workPane(g, ev(["/a"]))).toBe("p1")
    expect(workPane(g, ev(["/a"], "s1", { agentId: "sub" }))).toBe("p1")
  })

  it("never a background agent's, nor an older session's", () => {
    const g = reduceAgentEvents([start("s1"), start("bg", { nested: true })])
    expect(workPane(g, ev(["/a"], "bg"))).toBeUndefined()
    const g2 = reduceAgentEvents([start("s1"), start("s2")])
    expect(workPane(g2, ev(["/a"], "s1"))).toBeUndefined()
    expect(workPane(g2, ev(["/a"], "s2"))).toBe("p1")
    expect(workPane(g2, ev(["/a"], "unknown"))).toBeUndefined()
  })
})

describe("folder → root", () => {
  it("a lookup places its folder, and the folders below its root by path", () => {
    const roots = setDirRoots({}, { "/w/e/docs": repo("/real/e", "docs") }, 0)
    expect(roots["/w/e/docs"]).toEqual({ root: "/real/e", top: "/w/e", at: 0 })
    expect(rootOf("/w/e/docs", roots, "claude")).toBe("/real/e")
    expect(rootOf("/w/e", roots, "claude")).toBe("/real/e")
    expect(rootOf("/w/e/src/a", roots, "claude")).toBe("/real/e")
    expect(rootOf("/w/other", roots, "claude")).toBeUndefined()
    expect(rootOf("/w/ee", roots, "claude")).toBeUndefined()
  })

  it("an agent's nested worktree is its own checkout: looked up", () => {
    const roots = setDirRoots({}, { "/r": repo("/r") }, 0)
    expect(rootOf("/r/.claude/worktrees/x/src", roots, "claude")).toBeUndefined()
    expect(rootOf("/r/src", roots, "claude")).toBe("/r")
  })

  it("any nested checkout: placed by path only until its own lookup answers", () => {
    let roots = setDirRoots({}, { "/r": repo("/r") }, 0)
    expect(rootOf("/r/.worktrees/feat/src", roots, "codex")).toBe("/r") // provisional
    const w = work(["/r", 1], ["/r/.worktrees/feat/src", 3])
    expect(toResolve({ p1: w }, roots, 0).map((x) => x.dir)).toEqual(["/r/.worktrees/feat/src"])
    roots = setDirRoots(roots, { "/r/.worktrees/feat/src": repo("/r/.worktrees/feat", "src") }, 0)
    expect(rootOf("/r/.worktrees/feat/src", roots, "codex")).toBe("/r/.worktrees/feat")
    expect(settleWork(w, roots, ["/r"]).shown).toBe("/r/.worktrees/feat") // `from` = /r
    expect(toResolve({ p1: w }, roots, 0)).toEqual([])
  })

  it("a symlinked spelling that doesn't line up with git's prefix: that folder only", () => {
    const roots = setDirRoots({}, { "/link/x": repo("/real", "src/x") }, 0)
    expect(roots["/link/x"]!.top).toBeUndefined()
    expect(rootOf("/link/x", roots, "claude")).toBe("/real")
    expect(rootOf("/link/y", roots, "claude")).toBeUndefined()
  })

  it("not in a repo: asked again only when worked in ROOTLESS_TTL after that answer", () => {
    const roots = setDirRoots({}, { "/s": {} }, 1000)
    expect(rootOf("/s", roots, "claude")).toBeNull()
    expect(needsLookup(roots["/s"], 1000 + ROOTLESS_TTL - 1, 10 * ROOTLESS_TTL)).toBe(false)
    expect(needsLookup(roots["/s"], 1000 + ROOTLESS_TTL, 1000 + ROOTLESS_TTL)).toBe(true)
  })

  it("a failed lookup is no answer (placed by path meanwhile); asked again after RETRY_MS", () => {
    const roots = setDirRoots({}, { "/r": repo("/r"), "/r/x": undefined }, 0)
    expect(rootOf("/r/x", roots, "claude")).toBe("/r")
    expect(needsLookup(roots["/r/x"], 0, RETRY_MS - 1)).toBe(false)
    expect(needsLookup(roots["/r/x"], 0, RETRY_MS)).toBe(true)
    expect(needsLookup(roots["/r"], 1e9, 1e9)).toBe(false) // a repo's answer stands
    expect(needsLookup(undefined, 0, 0)).toBe(true)
  })

  it("no answers: the same map; a closed pane's folders go", () => {
    const roots = setDirRoots({}, { "/a": repo("/a"), "/b": repo("/b") }, 0)
    expect(setDirRoots(roots, {}, 5)).toBe(roots)
    const kept = keepDirRoots(roots, { p1: work(["/a", 1]) })
    expect(Object.keys(kept)).toEqual(["/a"])
    expect(keepDirRoots(kept, { p1: work(["/a", 1]) })).toBe(kept)
  })

  it("a checkout found gone: its folders are looked up again", () => {
    const roots = setDirRoots({}, { "/w/a": repo("/w/a"), "/o": repo("/o") }, 0)
    const next = forgetRoot(roots, "/w/a")
    expect(Object.keys(next)).toEqual(["/o"])
    expect(forgetRoot(next, "/nope")).toBe(next)
  })
})

describe("which checkout shows", () => {
  const roots = setDirRoots(
    {},
    { "/a": repo("/a"), "/b": repo("/b"), "/c": repo("/c"), "/from": repo("/from") },
    0,
  )

  it("most work first; `from` / `in` never; the rest for +N", () => {
    const w = settleWork(work(["/from", 9], ["/a", 3], ["/b", 1], ["/c", 3]), roots, ["/from"])
    expect(w.shown).toBe("/c") // a tie: the most recent
    expect(w.more).toEqual(["/a", "/b"])
  })

  it("groups a checkout's folders", () => {
    const r = setDirRoots(roots, { "/a/x": repo("/a", "x") }, 0)
    const w = settleWork(work(["/a/x", 2], ["/a/y", 2], ["/b", 3]), r, [])
    expect(w.shown).toBe("/a")
  })

  it("changes only when another leads by 2 (no flicker)", () => {
    let w = settleWork(work(["/a", 2]), roots, [])
    expect(w.shown).toBe("/a")
    const seq = { n: 100 }
    const more = (dir: string) => {
      w = settleWork(addWork(w, ev([dir]), ++seq.n, 0)!, roots, [])
      return w.shown
    }
    expect(more("/b")).toBe("/a")
    expect(more("/b")).toBe("/a") // a tie
    expect(more("/b")).toBe("/a") // leads by 1
    expect(more("/b")).toBe("/b") // leads by 2
  })

  it("the same reference when nothing it shows changed", () => {
    const w = settleWork(work(["/a", 1]), roots, [])
    expect(settleWork(w, roots, [])).toBe(w)
    const all = { p1: w }
    expect(settleAllWork(all, roots, {})).toBe(all)
  })

  it("excludes each pane's own `from` and `in` checkouts", () => {
    const all = { p1: settleWork(work(["/a", 2], ["/b", 1]), roots, []) }
    const next = settleAllWork(all, roots, {
      p1: { root: "/x" },
      [gitKey("p1", "in")]: { root: "/a" },
    })
    expect(next.p1!.shown).toBe("/b")
    expect(next.p1!.more).toEqual([])
  })

  it("unplaced or rootless folders show nothing", () => {
    const w = settleWork(work(["/nope", 5]), setDirRoots({}, { "/s": {} }, 0), [])
    expect(w.shown).toBeUndefined()
  })
})

describe("planEditPoll", () => {
  const sessions = [
    { id: "p1", command: "zsh", args: [] },
    { id: "p2", command: "zsh", args: [] },
  ]
  const roots = setDirRoots({}, { "/a": repo("/a") }, 0)
  const paneWork = {
    p1: settleWork(work(["/a", 1], ["/u1", 2], ["/u2", 1], ["/u3", 1]), roots, []),
  }

  it("the shown checkout (with its PR), at most 2 folders to place, and clears the rest", () => {
    const plan = planEditPoll(sessions, paneWork, roots, new Map(), 0)
    expect(plan.reqs).toEqual([
      { paneId: "p1@edit", cwd: "/a", wsl: undefined },
      { paneId: "resolve:0", cwd: "/u1", wsl: undefined, noPr: true },
      { paneId: "resolve:1", cwd: "/u3", wsl: undefined, noPr: true },
    ])
    expect(plan.polled).toEqual(["p1@edit", "p2@edit"])
    expect(plan.editCwd).toEqual({ "p1@edit": "/a" })
    expect(plan.resolves).toEqual({ "resolve:0": "/u1", "resolve:1": "/u3" })
  })

  it("the shown checkout every EDIT_EVERY, or at once when it changes", () => {
    const last = new Map([["p1@edit", { root: "/a", at: 0 }]])
    expect(planEditPoll(sessions, paneWork, roots, last, EDIT_EVERY - 1).editCwd).toEqual({})
    expect(planEditPoll(sessions, paneWork, roots, last, EDIT_EVERY).editCwd).toEqual({
      "p1@edit": "/a",
    })
    const moved = new Map([["p1@edit", { root: "/old", at: 0 }]])
    expect(planEditPoll(sessions, paneWork, roots, moved, 1).editCwd).toEqual({ "p1@edit": "/a" })
  })

  it("not due: not cleared either", () => {
    const last = new Map([["p1@edit", { root: "/a", at: 0 }]])
    expect(planEditPoll(sessions, paneWork, roots, last, 1).polled).toEqual(["p2@edit"])
  })

  it("toResolve skips placed and recently rootless folders, once each across panes", () => {
    const r = setDirRoots(roots, { "/u1": {} }, 0)
    const two = { ...paneWork, p2: work(["/u2", 9]) }
    expect(toResolve(two, r, 0, 5).map((x) => x.dir)).toEqual(["/u3", "/u2"])
  })
})

describe("gitKey", () => {
  it("each key back to its pane", () => {
    expect(paneOfGitKey(gitKey("p1"))).toBe("p1")
    expect(paneOfGitKey(gitKey("p1", "in"))).toBe("p1")
    expect(paneOfGitKey(gitKey("p1", "edit"))).toBe("p1")
  })

  it("`edit` answers are never taken for the shell's", () => {
    const res = { p1: {}, "p1@edit": {} }
    tagShellAnswers(res, [
      { paneId: "p1", cwd: "/s" },
      { paneId: "p1@edit", cwd: "/a" },
    ])
    expect(res).toEqual({ p1: { forCwd: "/s" }, "p1@edit": {} })
  })

  it("a failed `edit` lookup keeps its last answer for one poll", () => {
    const known = { "p1@edit": { root: "/a", branch: "b", forCwd: "/a" } }
    const res: Record<string, { root?: string; kept?: boolean; forCwd?: string }> = {
      "p1@edit": {},
    }
    settleInAnswers(res, { "p1@edit": "/a" }, known)
    expect(res["p1@edit"]).toMatchObject({ root: "/a", kept: true })
  })
})

describe("the sidebar's +N and flat selection", () => {
  it("worktrees and other checkouts, once each, never the shown one", () => {
    expect(moreFolders(["/w1", "/a"], ["/a/", "/b", "/w1"], "/a")).toEqual(["/w1", "/b"])
  })

  it("flat primitives, memoised per map", () => {
    const all: Record<string, PaneWork> = {
      p1: { session: "s", agent: "codex", dirs: {}, shown: "/a", more: ["/b", "/c"] },
    }
    const flat = paneWorkFlat(all)
    expect(flat).toEqual(["p1", "codex", "/a", "/b\n/c"])
    expect(paneWorkFlat(all)).toBe(flat)
  })
})
