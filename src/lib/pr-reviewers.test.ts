import { describe, expect, it } from "vitest"
import { parsePrRow, parsePrRowAnswer, type PrRow } from "./pr-dashboard"
import {
  guessRow,
  isReviewer,
  parseCandidates,
  pickerEntries,
  reviewerEditArgs,
  withHeld,
  type PrCandidates,
} from "./pr-reviewers"

const row = (over: Partial<PrRow> = {}): PrRow => ({
  ...parsePrRow({
    number: 7,
    title: "feat: x",
    url: "https://github.com/o/r/pull/7",
    state: "OPEN",
    updatedAt: "2026-10-14T09:00:00Z",
    author: { login: "me" },
    repository: { nameWithOwner: "o/r" },
  })!,
  ...over,
})

const answer = (data: Record<string, unknown>) => JSON.stringify({ data })

describe("parseCandidates", () => {
  it("suggestions, assignable people, and an org's teams", () => {
    const out = answer({
      repository: {
        pullRequest: { suggestedReviewers: [{ reviewer: { login: "ann", name: "Ann" } }] },
        assignableUsers: { nodes: [{ login: "bob", name: null }, { login: "-x" }] },
      },
      repositoryOwner: {
        __typename: "Organization",
        teams: { nodes: [{ combinedSlug: "o/core", name: "Core" }] },
      },
    })
    expect(parseCandidates(out, true)).toEqual({
      suggested: [{ login: "ann", name: "Ann", team: false, suggested: true }],
      people: [{ login: "bob", name: "", team: false, suggested: false }],
      teams: [{ login: "o/core", name: "Core", team: true, suggested: false }],
    })
  })

  it("a user's repo has no teams; teams not asked for: the read:org hint", () => {
    const repository = { assignableUsers: { nodes: [] } }
    expect(
      parseCandidates(answer({ repository, repositoryOwner: { __typename: "User" } }), true),
    ).toEqual({ suggested: [], people: [], teams: null })
    expect(parseCandidates(answer({ repository }), false)?.teams).toBe("no-scope")
  })

  it("not an answer: null, never throws", () => {
    expect(parseCandidates("nope", true)).toBeNull()
    expect(parseCandidates(answer({ repository: null }), true)).toBeNull()
    expect(parseCandidates(JSON.stringify([1]), true)).toBeNull()
  })
})

describe("pickerEntries", () => {
  const c: PrCandidates = {
    suggested: [{ login: "Ann", name: "", team: false, suggested: true }],
    people: [
      { login: "ann", name: "", team: false, suggested: false },
      { login: "me", name: "", team: false, suggested: false },
      { login: "bob", name: "", team: false, suggested: false },
      { login: "cy", name: "", team: false, suggested: false },
    ],
    teams: [{ login: "o/core", name: "", team: true, suggested: false }],
  }

  it("suggestions first, one entry per login, the author left out, review state beside", () => {
    const r = row({ requested: ["bob", "o/core"], reviewers: [{ login: "cy", state: "approved" }] })
    expect(pickerEntries(c, r).map((e) => [e.login, e.suggested, e.status])).toEqual([
      ["Ann", true, null],
      ["bob", false, "requested"],
      ["cy", false, "reviewed"],
      ["o/core", false, "requested"],
    ])
  })

  it("no teams (a user's repo, or no read:org): people only", () => {
    expect(pickerEntries({ ...c, teams: "no-scope" }, row()).some((e) => e.team)).toBe(false)
  })
})

describe("reviewer edits", () => {
  it("only logins and org/team slugs reach gh: never an option or a list", () => {
    for (const ok of ["ann", "a-b", "jdoe_acme", "o/core", "o/team.x_y"])
      expect(isReviewer(ok)).toBe(true)
    for (const bad of ["", "-x", "--repo", "a,b", "a b", "o/", "/t", "a/b/c", 1])
      expect(isReviewer(bad)).toBe(false)
  })

  it("gh pr edit with --repo; anything that isn't a reviewer: no edit at all", () => {
    expect(
      reviewerEditArgs({ repo: "o/r", number: 7, add: ["ann", "o/core"], remove: ["bob"] }),
    ).toEqual([
      "pr",
      "edit",
      "7",
      "--repo",
      "o/r",
      "--add-reviewer",
      "ann,o/core",
      "--remove-reviewer",
      "bob",
    ])
    expect(reviewerEditArgs({ repo: "o/r", number: 7, add: ["ann", "--x"], remove: [] })).toBeNull()
    expect(reviewerEditArgs({ repo: "o/r", number: 7, add: [], remove: [] })).toBeNull()
  })
})

describe("withHeld", () => {
  const T0 = "2026-10-14T09:00:00Z"
  const T1 = "2026-10-14T10:00:00Z"
  const b = row({ number: 8, url: "https://github.com/o/r/pull/8" })

  it("the PR's own row over list copies older than it, in every list", () => {
    const own = row({ requested: ["ann"], updatedAt: T1 })
    const lists = { mine: [row({ updatedAt: T0 }), b], review: [row({ updatedAt: T0 })] }
    const out = withHeld(lists, [own])
    expect(out.mine).toEqual([own, b])
    expect(out.review).toEqual([own])
    expect(out).not.toHaveProperty("repo")
  })

  it("a copy as new (CI moved on) or newer is the list's own; per list", () => {
    const own = row({ requested: ["ann"], updatedAt: T1 })
    const caughtUp = row({ requested: ["ann"], ci: "failure", updatedAt: T1 })
    const lists = { mine: [caughtUp], review: [row({ updatedAt: T0 })] }
    const out = withHeld(lists, [own])
    expect(out.mine).toEqual([caughtUp])
    expect(out.review).toEqual([own])
    const none = { mine: [caughtUp], review: [] }
    expect(withHeld(none, [own])).toBe(none)
  })
})

describe("guessRow", () => {
  it("the login requested, or not, once; a hair newer than its row", () => {
    const r = row({ requested: ["ann", "bob"] })
    expect(guessRow(r, "bob", false).requested).toEqual(["ann"])
    expect(guessRow(r, "bob", true).requested).toEqual(["ann", "bob"])
    expect(guessRow(r, "cy", true).requested).toEqual(["ann", "bob", "cy"])
    expect(guessRow(r, "cy", true).updatedAt).toBe("2026-10-14T09:00:00.001Z")
  })
})

describe("parsePrRowAnswer", () => {
  it("the PR asked for directly → its row; anything else: null", () => {
    const out = answer({ repository: { pullRequest: { number: 7, url: "u", state: "OPEN" } } })
    expect(parsePrRowAnswer(out)).toMatchObject({ number: 7, url: "u", state: "open" })
    expect(parsePrRowAnswer("{")).toBeNull()
    expect(parsePrRowAnswer(answer({ repository: null }))).toBeNull()
  })
})

describe("withHeld times", () => {
  it("compares times, not strings (a guess has milliseconds, GitHub's don't)", () => {
    const listed = row({ updatedAt: "2026-10-14T09:00:00Z" })
    const guess = guessRow(listed, "ann", true)
    expect(withHeld({ mine: [listed], review: [] }, [guess]).mine).toEqual([guess])
  })
})

describe("withHeld accounts", () => {
  it("only the copy listed as the same account takes the held row", () => {
    const T0 = "2026-10-14T09:00:00Z"
    const held = row({ requested: ["ann"], updatedAt: "2026-10-14T10:00:00Z", account: "b" })
    const asA = row({ updatedAt: T0, account: "a" })
    const asB = row({ updatedAt: T0, account: "b" })
    const out = withHeld({ mine: [asA], review: [], repo: [asB] }, [held])
    expect(out.mine).toEqual([asA])
    expect(out.repo).toEqual([held])
  })
})
