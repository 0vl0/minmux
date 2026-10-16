import { describe, expect, it } from "vitest"
import {
  behindText,
  branchArgs,
  branchDone,
  chipAction,
  parseBranchOptions,
  pullHeadRef,
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
const ALL: PrBranchOptions = { canUpdateBranch: true, canEdit: true, behind: 2 }
const NONE: PrBranchOptions = { canUpdateBranch: false, canEdit: false, behind: 2 }

describe("chipAction", () => {
  it("behind base: update; a draft: ready; open: back to draft", () => {
    expect(chipAction("behind base", row({ merge: "behind" }), ALL)).toBe("update")
    expect(chipAction("draft", row({ state: "draft" }), ALL)).toBe("ready")
    expect(chipAction("open", row(), ALL)).toBe("draft")
    expect(chipAction("CI passed", row(), ALL)).toBeNull()
  })

  it("nothing the account can't do, nothing before GitHub says, nothing on a stale chip", () => {
    expect(chipAction("behind base", row({ merge: "behind" }), NONE)).toBeNull()
    expect(chipAction("draft", row({ state: "draft" }), NONE)).toBeNull()
    expect(chipAction("open", row(), undefined)).toBeNull()
    // (the row moved on: up to date, merged)
    expect(chipAction("behind base", row({ merge: "clean" }), ALL)).toBeNull()
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
  it("the row shows it: up to date, open, a draft", () => {
    expect(branchDone("update", row({ merge: "behind" }))).toBe(false)
    expect(branchDone("update", row({ merge: "unknown" }))).toBe(true) // (GitHub recomputing)
    expect(branchDone("ready", row())).toBe(true)
    expect(branchDone("ready", row({ state: "draft" }))).toBe(false)
    expect(branchDone("draft", row({ state: "draft" }))).toBe(true)
  })
})

describe("parseBranchOptions / behindText / pullHeadRef", () => {
  it("a count only when GitHub gave a whole one", () => {
    expect(parseBranchOptions({ baseRef: { compare: { behindBy: -1 } } }).behind).toBeNull()
    expect(parseBranchOptions({ baseRef: { compare: { behindBy: "3" } } }).behind).toBeNull()
    expect(behindText(1, "main")).toBe("1 commit behind main")
    expect(behindText(4, "dev")).toBe("4 commits behind dev")
    expect(behindText(null, "main")).toBe("Behind main")
    expect(pullHeadRef(12)).toBe("refs/pull/12/head")
  })
})
