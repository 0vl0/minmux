import { describe, expect, it } from "vitest"
import {
  mergeArgs,
  mergeBlocked,
  parseMergeOptions,
  startMethod,
  type PrMergeOptions,
} from "./pr-merge"
import type { PrRow } from "./pr-dashboard"

const HEAD = "c".repeat(40)
const opts = (over: Partial<PrMergeOptions> = {}): PrMergeOptions => ({
  methods: ["merge", "squash", "rebase"],
  preferred: null,
  canMerge: true,
  head: HEAD,
  ...over,
})
const row = (over: Partial<PrRow> = {}) => ({ state: "open", merge: "clean", ...over }) as PrRow

describe("parseMergeOptions", () => {
  it("the repo's allowed ways, GitHub's remembered one, and write access", () => {
    expect(
      parseMergeOptions(
        {
          mergeCommitAllowed: false,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          viewerDefaultMergeMethod: "REBASE",
          viewerPermission: "WRITE",
        },
        HEAD,
      ),
    ).toEqual({ methods: ["squash", "rebase"], preferred: "rebase", canMerge: true, head: HEAD })
  })

  it("a remembered way the repo no longer allows, read access, a bad head: none of them", () => {
    expect(
      parseMergeOptions(
        { squashMergeAllowed: true, viewerDefaultMergeMethod: "MERGE", viewerPermission: "READ" },
        "nope",
      ),
    ).toEqual({ methods: ["squash"], preferred: null, canMerge: false, head: "" })
    expect(parseMergeOptions(null, HEAD)).toBeNull()
  })
})

describe("startMethod", () => {
  it("this repo's last pick, else GitHub's, else the first allowed", () => {
    expect(startMethod(opts({ preferred: "merge" }), "rebase")).toBe("rebase")
    expect(startMethod(opts({ preferred: "merge" }), "bogus")).toBe("merge")
    expect(startMethod(opts({ methods: ["squash"] }), "rebase")).toBe("squash")
    expect(startMethod(opts({ methods: [] }), null)).toBeNull()
  })
})

describe("mergeBlocked", () => {
  it("drafts, conflicts, no way: said; blocked or behind: tried (GitHub decides)", () => {
    expect(mergeBlocked(row({ state: "draft" }), opts())).toMatch(/draft/)
    expect(mergeBlocked(row({ merge: "conflicts" }), opts())).toMatch(/conflicts/)
    expect(mergeBlocked(row(), opts({ methods: [] }))).toMatch(/no way/)
    expect(mergeBlocked(row({ merge: "blocked" }), opts())).toBeNull()
    expect(mergeBlocked(row({ merge: "behind" }), opts())).toBeNull()
  })
})

describe("mergeArgs", () => {
  it("the way as gh's flag, the head pinned when known", () => {
    expect(mergeArgs({ repo: "o/r", number: 3, method: "rebase", head: HEAD })).toEqual([
      "pr",
      "merge",
      "3",
      "--repo",
      "o/r",
      "--rebase",
      "--match-head-commit",
      HEAD,
    ])
    expect(mergeArgs({ repo: "o/r", number: 3, method: "merge", head: "abc" })).toEqual([
      "pr",
      "merge",
      "3",
      "--repo",
      "o/r",
      "--merge",
    ])
  })

  it("never an option smuggled in, a bad number, or an unknown way", () => {
    expect(mergeArgs({ repo: "--admin", number: 3, method: "merge" })).toBeNull()
    expect(mergeArgs({ repo: "-x/r", number: 3, method: "merge" })).toBeNull()
    expect(mergeArgs({ repo: "o/r", number: 0, method: "merge" })).toBeNull()
    expect(mergeArgs({ repo: "o/r", number: 3, method: "admin" as "merge" })).toBeNull()
  })
})
