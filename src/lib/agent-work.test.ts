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
  CHECK_EVERY,
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
  it("a lookup places its folder only (a nested checkout is its own lookup's answer)", () => {
    const roots = setDirRoots({}, { "/r/src": "/r", "/r/.worktrees/f/src": "/r/.worktrees/f" }, 0)
    expect(roots["/r/src"]).toEqual({ root: "/r", at: 0 })
    expect(rootOf("/r/src", roots)).toBe("/r")
    expect(rootOf("/r/.worktrees/f/src", roots)).toBe("/r/.worktrees/f")
    expect(rootOf("/r/docs", roots)).toBeUndefined()
    const w = work(["/r/src", 1], ["/r/.worktrees/f/src", 3])
    expect(settleWork(w, roots, ["/r"]).shown).toBe("/r/.worktrees/f") // `from` = /r
  })

  it("not in a repo: asked again only when worked in ROOTLESS_TTL after that answer", () => {
    const roots = setDirRoots({}, { "/s": null, "/f": undefined }, 1000)
    expect(rootOf("/s", roots)).toBeNull()
    expect(roots["/f"]!.failed).toBe(true) // no answer: a failed lookup
    expect(rootOf("/f", roots)).toBeUndefined()
    expect(needsLookup(roots["/s"], 1000 + ROOTLESS_TTL - 1, 10 * ROOTLESS_TTL)).toBe(false)
    expect(needsLookup(roots["/s"], 1000 + ROOTLESS_TTL, 1000 + ROOTLESS_TTL)).toBe(true)
  })

  it("a failed lookup is asked again once after RETRY_MS, then only when worked in again", () => {
    const roots = setDirRoots({}, { "/r": "/r", "/r/x": undefined }, 0)
    expect(needsLookup(roots["/r/x"], 0, RETRY_MS - 1)).toBe(false)
    expect(needsLookup(roots["/r/x"], 0, RETRY_MS)).toBe(true)
    const again = setDirRoots(roots, { "/r/x": undefined }, RETRY_MS) // no timer any more
    expect(needsLookup(again["/r/x"], 0, 100 * RETRY_MS)).toBe(false)
    expect(needsLookup(again["/r/x"], RETRY_MS + ROOTLESS_TTL, 100 * RETRY_MS)).toBe(true)
    expect(needsLookup(roots["/r"], 1e9, 1e9)).toBe(false) // a repo's answer stands
    expect(needsLookup(undefined, 0, 0)).toBe(true)
  })

  it("no answers: the same map; a closed pane's folders go", () => {
    const roots = setDirRoots({}, { "/a": "/a", "/b": "/b" }, 0)
    expect(setDirRoots(roots, {}, 5)).toBe(roots)
    const kept = keepDirRoots(roots, { p1: work(["/a", 1]) })
    expect(Object.keys(kept)).toEqual(["/a"])
    expect(keepDirRoots(kept, { p1: work(["/a", 1]) })).toBe(kept)
  })

  it("a checkout found gone: its folders are looked up again", () => {
    const roots = setDirRoots({}, { "/w/a": "/w/a", "/o": "/o" }, 0)
    const next = forgetRoot(roots, "/w/a")
    expect(Object.keys(next)).toEqual(["/o"])
    expect(forgetRoot(next, "/nope")).toBe(next)
  })
})

describe("which checkout shows", () => {
  const roots = setDirRoots({}, { "/a": "/a", "/b": "/b", "/c": "/c", "/from": "/from" }, 0)

  it("most work first; `from` / `in` never; the rest for +N", () => {
    const w = settleWork(work(["/from", 9], ["/a", 3], ["/b", 1], ["/c", 3]), roots, ["/from"])
    expect(w.shown).toBe("/c") // a tie: the most recent
    expect(w.more).toEqual(["/a", "/b"])
  })

  it("groups a checkout's folders", () => {
    const r = setDirRoots(roots, { "/a/x": "/a", "/a/y": "/a" }, 0)
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

  it("a failed shell lookup keeps what shows; with nothing shown yet, it settles", () => {
    const failed = { p1: { real: "/x" } } // no root, no "not a repo"
    const grown = { p1: settleWork(work(["/a", 3], ["/b", 9]), roots, []) }
    expect(settleAllWork({ p1: { ...grown.p1!, shown: "/a" } }, roots, failed).p1!.shown).toBe("/a")
    const fresh = { p1: work(["/a", 1]) }
    expect(settleAllWork(fresh, roots, failed).p1!.shown).toBe("/a") // an unborn repo's pane
  })

  it("unplaced or rootless folders show nothing", () => {
    const w = settleWork(work(["/nope", 5]), setDirRoots({}, { "/s": null }, 0), [])
    expect(w.shown).toBeUndefined()
  })
})

describe("planEditPoll", () => {
  const sessions = [
    { id: "p1", command: "zsh", args: [] },
    { id: "p2", command: "zsh", args: [] },
  ]
  const roots = setDirRoots({}, { "/a": "/a" }, 0)
  const paneWork = {
    p1: settleWork(work(["/a", 1], ["/u1", 2], ["/u2", 1], ["/u3", 1]), roots, []),
  }

  it("the shown checkout (with its PR), host folders to walk, and clears the rest", () => {
    const plan = planEditPoll(sessions, paneWork, roots, new Map(), 0)
    expect(plan.reqs).toEqual([{ paneId: "p1@edit", cwd: "/a", wsl: undefined }])
    expect(plan.walks).toEqual(["/u1", "/u3", "/u2"]) // most worked, then most recent
    expect(plan.polled).toEqual(["p1@edit", "p2@edit"])
    expect(plan.editCwd).toEqual({ "p1@edit": "/a" })
    expect(plan.resolves).toEqual({})
  })

  it("a WSL pane's folders ask git, at most MAX_RESOLVES per round", () => {
    const wsl = [{ id: "p1", command: "wsl.exe", args: ["-d", "Ubuntu"] }]
    const plan = planEditPoll(wsl, paneWork, roots, new Map(), 0)
    expect(plan.walks).toEqual([])
    expect(plan.resolves).toEqual({ "resolve:0": "/u1", "resolve:1": "/u3" })
    expect(plan.reqs.filter((r) => r.noPr).map((r) => r.cwd)).toEqual(["/u1", "/u3"])
    expect(plan.reqs[1]!.wsl).toBeDefined()
  })

  it("a closed pane's folders are never asked for", () => {
    expect(planEditPoll([], paneWork, roots, new Map(), 0).walks).toEqual([])
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

  it("one `+N` checkout per round, each CHECK_EVERY after it was first seen", () => {
    const pw = { p1: { ...paneWork.p1!, more: ["/m1", "/m2"] } }
    const last = new Map([["p1@edit", { root: "/a", at: 0 }]])
    expect(planEditPoll(sessions, pw, roots, last, 1, new Map()).checks).toEqual({})
    const seen = new Map([
      ["/m1", 0],
      ["/m2", 0],
    ])
    expect(planEditPoll(sessions, pw, roots, last, CHECK_EVERY - 1, seen).checks).toEqual({})
    const plan = planEditPoll(sessions, pw, roots, last, CHECK_EVERY, seen)
    expect(plan.checks).toEqual({ "check:0": "/m1" })
    expect(plan.reqs).toContainEqual({ paneId: "check:0", cwd: "/m1", wsl: undefined, noPr: true })
  })

  it("not due: not cleared either", () => {
    const last = new Map([["p1@edit", { root: "/a", at: 0 }]])
    expect(planEditPoll(sessions, paneWork, roots, last, 1).polled).toEqual(["p2@edit"])
  })

  it("toResolve skips placed and recently rootless folders, once each across panes", () => {
    const r = setDirRoots(roots, { "/u1": undefined }, 0)
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
