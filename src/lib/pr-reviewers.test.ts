import { describe, expect, it } from "vitest"
import { parsePrRow, parsePrRowAnswer, type PrRow } from "./pr-dashboard"
import {
  EDIT_HOLD_MS,
  editedFrom,
  guessRow,
  isReviewer,
  parseCandidates,
  patchRow,
  pickerEntries,
  reviewerEditArgs,
  withEdits,
  type EditedReviewers,
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

describe("patchRow", () => {
  const a = row()
  const b = row({ number: 8, url: "https://github.com/o/r/pull/8" })

  it("the PR's newer row in every tab it's in; the same lists when it's in none", () => {
    const lists = { mine: [a, b], review: [a] }
    const fresh = row({ requested: ["ann"], updatedAt: "2026-10-14T10:00:00Z" })
    const out = patchRow(lists, fresh)
    expect(out.mine).toEqual([fresh, b])
    expect(out.review).toEqual([fresh])
    expect(out).not.toHaveProperty("repo")
    const other = row({ number: 9, url: "https://github.com/o/r/pull/9" })
    expect(patchRow(lists, other)).toBe(lists)
  })
})

describe("withEdits", () => {
  it("a list that doesn't show the change yet keeps it; only the review fields", () => {
    const fresh = row({ requested: ["ann"], review: "required" })
    const edited = new Map<string, EditedReviewers>([[fresh.url, editedFrom(fresh, 0)]])
    const lists = { mine: [row({ ci: "failure", state: "merged" })], review: [] }
    const out = withEdits(lists, edited, 1000).mine[0]!
    expect(out).toMatchObject({ requested: ["ann"], review: "required", ci: "failure" })
    expect(out.state).toBe("merged") // what the list knows past the change stays
    expect(edited.size).toBe(1)
  })

  it("dropped once a list shows it (any case, any order), or after the hold", () => {
    const fresh = row({ requested: ["Ann", "o/core"] })
    const edited = new Map<string, EditedReviewers>([[fresh.url, editedFrom(fresh, 0)]])
    const shown = { mine: [row({ requested: ["o/core", "ann"], ci: "success" })], review: [] }
    expect(withEdits(shown, edited, 1)).toBe(shown)
    expect(edited.size).toBe(0)
    edited.set(fresh.url, editedFrom(fresh, 0))
    const lagging = { mine: [row()], review: [] }
    expect(withEdits(lagging, edited, EDIT_HOLD_MS)).toBe(lagging)
    expect(edited.size).toBe(0)
  })

  it("a guessed row: the login requested, or not, once", () => {
    const r = row({ requested: ["ann", "bob"] })
    expect(guessRow(r, "bob", false).requested).toEqual(["ann"])
    expect(guessRow(r, "bob", true).requested).toEqual(["ann", "bob"])
    expect(guessRow(r, "cy", true).requested).toEqual(["ann", "bob", "cy"])
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
