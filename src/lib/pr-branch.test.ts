import { describe, expect, it } from "vitest"
import {
  behindText,
  branchArgs,
  branchDone,
  behindUnsaid,
  chipAction,
  parseBehind,
  parseBranchOptions,
  pullHeadRef,
  stateAction,
  type PrBranchOptions,
} from "./pr-branch"
import type { PrRow } from "./pr-dashboard"

const row = (over: Partial<PrRow> = {}): PrRow => ({
  number: 7,
  title: "t",
  url: "https://github.com/o/r/pull/7",
  repo: "o/r",
  author: "me",
  state: "open",
  head: "feat/x",
  fork: false,
  base: "main",
  review: null,
  reviewers: [],
  requested: [],
  merge: "clean",
  ci: null,
  comments: 0,
  additions: 0,
  deletions: 0,
  updatedAt: "",
  ...over,
})
const ALL: PrBranchOptions = {
  canUpdateBranch: true,
  canEdit: true,
  canClose: true,
  canReopen: true,
  behind: 2,
}
const NONE: PrBranchOptions = {
  canUpdateBranch: false,
  canEdit: false,
  canClose: false,
  canReopen: false,
  behind: 2,
}

describe("chipAction", () => {
  it("behind base: update; a draft: ready; open: back to draft", () => {
    expect(chipAction("behind base", row({ merge: "behind" }), ALL)).toBe("update")
    // (behind by GitHub's count in a repo that doesn't require up to date)
    expect(chipAction("behind base", row({ merge: "clean" }), ALL)).toBe("update")
    expect(chipAction("draft", row({ state: "draft" }), ALL)).toBe("ready")
    expect(chipAction("open", row(), ALL)).toBe("draft")
    expect(chipAction("CI passed", row(), ALL)).toBeNull()
  })

  it("nothing the account can't do, nothing before GitHub says, nothing on a stale chip", () => {
    expect(chipAction("behind base", row({ merge: "behind" }), NONE)).toBeNull()
    expect(chipAction("draft", row({ state: "draft" }), NONE)).toBeNull()
    expect(chipAction("open", row(), undefined)).toBeNull()
    // (the row moved on: up to date, merged)
    expect(chipAction("behind base", row(), { ...ALL, behind: 0 })).toBeNull()
    expect(chipAction("behind base", row({ state: "merged" }), ALL)).toBeNull()
    expect(chipAction("open", row({ state: "merged" }), ALL)).toBeNull()
  })
})

describe("branchArgs", () => {
  it("a merge of the base in (never a rebase), ready, back to draft", () => {
    expect(branchArgs({ repo: "o/r", number: 7, action: "update" })).toEqual([
      "pr",
      "update-branch",
      "7",
      "--repo",
      "o/r",
    ])
    expect(branchArgs({ repo: "o/r", number: 7, action: "ready" })).toEqual([
      "pr",
      "ready",
      "7",
      "--repo",
      "o/r",
    ])
    expect(branchArgs({ repo: "o/r", number: 7, action: "draft" })).toEqual([
      "pr",
      "ready",
      "7",
      "--repo",
      "o/r",
      "--undo",
    ])
  })

  it("nothing gh would take as an option or another PR", () => {
    expect(branchArgs({ repo: "--x/r", number: 7, action: "ready" })).toBeNull()
    expect(branchArgs({ repo: "o/r", number: 0, action: "ready" })).toBeNull()
    expect(branchArgs({ repo: "o/r", number: 7, action: "rebase" as "update" })).toBeNull()
  })
})

describe("branchDone", () => {
  it("an update: GitHub counts none behind; no count: the row's merge state", () => {
    expect(branchDone("update", row({ merge: "clean" }), 2)).toBe(false) // (no "up to date" rule)
    expect(branchDone("update", row({ merge: "behind" }), 0)).toBe(true) // (state lagging)
    expect(branchDone("update", row({ merge: "behind" }), null)).toBe(false)
    expect(branchDone("update", row({ merge: "unknown" }), null)).toBe(true)
  })

  it("ready: open; back to draft: a draft", () => {
    expect(branchDone("ready", row(), null)).toBe(true)
    expect(branchDone("ready", row({ state: "draft" }), null)).toBe(false)
    expect(branchDone("draft", row({ state: "draft" }), null)).toBe(true)
  })
})

describe("behindUnsaid", () => {
  it("behind by GitHub's count, its merge state silent: open or draft, never conflicts", () => {
    expect(behindUnsaid(row({ merge: "clean" }), ALL)).toBe(true)
    expect(behindUnsaid(row({ merge: "blocked", state: "draft" }), ALL)).toBe(true)
    expect(behindUnsaid(row({ merge: "behind" }), ALL)).toBe(false) // (statusParts says it)
    expect(behindUnsaid(row({ merge: "conflicts" }), ALL)).toBe(false)
    expect(behindUnsaid(row({ state: "merged" }), ALL)).toBe(false)
    expect(behindUnsaid(row(), { ...ALL, behind: 0 })).toBe(false)
    expect(behindUnsaid(row(), undefined)).toBe(false)
  })
})

describe("parseBranchOptions / behindText / pullHeadRef", () => {
  it("a count only when GitHub gave a whole one", () => {
    expect(parseBranchOptions({ baseRef: { compare: { behindBy: -1 } } }).behind).toBeNull()
    expect(parseBranchOptions({ baseRef: { compare: { behindBy: "3" } } }).behind).toBeNull()
    expect(behindText(1, "main")).toBe("1 commit behind main")
    expect(behindText(4, "dev")).toBe("4 commits behind dev")
    expect(behindText(null, "main")).toBe("Behind main")
    expect(behindText(0, "main")).toBe("0 commits behind main")
    expect(pullHeadRef(12)).toBe("refs/pull/12/head")
  })
})

describe("parseBehind", () => {
  it("the count, or null for anything else", () => {
    const out = (pr: unknown) => JSON.stringify({ data: { repository: { pullRequest: pr } } })
    expect(parseBehind(out({ baseRef: { compare: { behindBy: 5 } } }))).toBe(5)
    expect(parseBehind(out({ baseRef: null }))).toBeNull()
    expect(parseBehind(out(null))).toBeNull()
    expect(parseBehind("nope")).toBeNull()
  })
})

describe("close and reopen", () => {
  it("the icon: close an open or draft PR, reopen a closed one, only when GitHub lets this account", () => {
    expect(stateAction(row({ state: "open" }), ALL)).toBe("close")
    expect(stateAction(row({ state: "draft" }), ALL)).toBe("close")
    expect(stateAction(row({ state: "closed" }), ALL)).toBe("reopen")
    expect(stateAction(row({ state: "merged" }), ALL)).toBeNull()
    expect(stateAction(row({ state: "open" }), NONE)).toBeNull()
    expect(stateAction(row({ state: "closed" }), undefined)).toBeNull()
  })

  it("gh's commands, and when the row shows it done", () => {
    const req = { repo: "o/r", number: 7 }
    expect(branchArgs({ ...req, action: "close" })).toEqual(["pr", "close", "7", "--repo", "o/r"])
    expect(branchArgs({ ...req, action: "reopen" })).toEqual(["pr", "reopen", "7", "--repo", "o/r"])
    expect(branchDone("close", row({ state: "closed" }), null)).toBe(true)
    expect(branchDone("close", row({ state: "open" }), null)).toBe(false)
    expect(branchDone("reopen", row({ state: "draft" }), null)).toBe(true)
  })
})
