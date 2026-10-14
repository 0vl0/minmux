import { describe, expect, it } from "vitest"
import type { PrRow } from "./pr-dashboard"
import { baseOf, stackedOn, stackRows } from "./pr-stacks"

const pr = (n: number, head: string, base: string, over: Partial<PrRow> = {}): PrRow => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  repo: "o/r",
  author: "me",
  state: "open",
  head,
  fork: false,
  base,
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

const shape = (rows: ReturnType<typeof stackRows>) =>
  rows.map(
    (s) =>
      `${"  ".repeat(s.depth)}#${s.row.number}${s.last ? "" : "+"}${s.on ? ` on #${s.on.number}` : ""}`,
  )

describe("stackRows", () => {
  it("each PR under the one it's based on, in the list's order", () => {
    // newest first: 3 on 2 on 1; 4 on 1; 5 alone
    const rows = [
      pr(3, "c", "b"),
      pr(5, "e", "main"),
      pr(4, "d", "a"),
      pr(2, "b", "a"),
      pr(1, "a", "main"),
    ]
    expect(shape(stackRows(rows))).toEqual(["#5", "#1", "  #4+", "  #2", "    #3"])
  })

  it("only within one repo; a fork's head is never a base", () => {
    const other = pr(9, "b", "a", { repo: "x/y", url: "https://github.com/x/y/pull/9" })
    const fork = pr(2, "a", "main", { fork: true })
    const rows = [pr(3, "c", "a"), other, fork]
    expect(shape(stackRows(rows))).toEqual(["#3", "#9", "#2"])
    // a fork PR can still be stacked on a branch of the repo
    expect(shape(stackRows([pr(1, "a", "main"), pr(8, "z", "a", { fork: true })]))).toEqual([
      "#1",
      "  #8",
    ])
  })

  it("a base PR in another tab: 'on #N'", () => {
    const base = pr(1, "a", "main")
    expect(shape(stackRows([pr(2, "b", "a")], [base, pr(2, "b", "a")]))).toEqual(["#2 on #1"])
  })

  it("a cycle, or two PRs on one head: every PR listed once", () => {
    const rows = [pr(1, "a", "b"), pr(2, "b", "a")]
    expect(
      stackRows(rows)
        .map((s) => s.row.number)
        .sort(),
    ).toEqual([1, 2])
    const twice = [pr(1, "a", "main"), pr(2, "a", "main"), pr(3, "c", "a")]
    expect(
      stackRows(twice)
        .map((s) => s.row.number)
        .sort(),
    ).toEqual([1, 2, 3])
  })
})

describe("stackRows connectors and open bases", () => {
  it("an ancestor's line runs on past its children while it has siblings below", () => {
    // 1 ← (2 ← 3), 4
    const rows = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "b"), pr(4, "d", "a")]
    expect(stackRows(rows).map((s) => [s.row.number, s.guides, s.last])).toEqual([
      [1, [], true],
      [2, [], false],
      [3, [true], true],
      [4, [], true],
    ])
  })

  it("an open PR on a branch is its base, not a merged one listed first", () => {
    const merged = pr(10, "x", "main", { state: "merged" })
    const open = pr(20, "x", "main")
    const top = pr(21, "y", "x")
    const rows = [merged, open, top]
    expect(baseOf(top, rows)?.number).toBe(20)
    expect(stackedOn(merged, rows)).toEqual([])
    expect(stackedOn(open, rows).map((r) => r.number)).toEqual([21])
  })
})

describe("baseOf / stackedOn", () => {
  it("the PR below and the PRs above", () => {
    const rows = [
      pr(1, "a", "main"),
      pr(2, "b", "a"),
      pr(3, "c", "a"),
      pr(4, "a", "main", { fork: true, url: "f" }),
    ]
    expect(baseOf(rows[1]!, rows)?.number).toBe(1)
    expect(baseOf(rows[0]!, rows)).toBeNull()
    expect(stackedOn(rows[0]!, rows).map((r) => r.number)).toEqual([2, 3])
    expect(stackedOn(rows[3]!, rows)).toEqual([])
  })
})
