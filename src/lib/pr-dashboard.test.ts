import { describe, expect, it } from "vitest"
import {
  githubRepoOf,
  nextRefreshMs,
  parsePrLists,
  parsePrRow,
  prSearches,
  statusParts,
  tabFor,
  type PrRow,
  mergePart,
  type PrListsResult,
  type PrLists,
  openOnly,
} from "./pr-dashboard"

/** A search node as GitHub answers it (only what a test changes is passed). */
const node = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "feat: x",
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-10-14T09:00:00Z",
  author: { login: "me" },
  repository: { nameWithOwner: "o/r" },
  headRefName: "feat/x",
  baseRefName: "main",
  reviewDecision: null,
  mergeStateStatus: "CLEAN",
  additions: 3,
  deletions: 1,
  comments: { totalCount: 1 },
  reviewThreads: { totalCount: 2 },
  latestOpinionatedReviews: { nodes: [] },
  reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...over,
})

describe("parsePrRow", () => {
  it("a PR's status: state, review, merge, CI, comments", () => {
    expect(parsePrRow(node())).toMatchObject({
      number: 7,
      repo: "o/r",
      state: "open",
      head: "feat/x",
      base: "main",
      review: null,
      merge: "clean",
      ci: "success",
      comments: 3,
    })
    expect(parsePrRow(node({ isDraft: true }))!.state).toBe("draft")
    expect(parsePrRow(node({ state: "MERGED", isDraft: true }))!.state).toBe("merged")
    expect(parsePrRow(node({ state: "CLOSED" }))!.state).toBe("closed")
    expect(parsePrRow(node({ reviewDecision: "CHANGES_REQUESTED" }))!.review).toBe("changes")
    expect(parsePrRow(node({ mergeStateStatus: "BEHIND" }))!.merge).toBe("behind")
    expect(parsePrRow(node({ mergeStateStatus: "DIRTY" }))!.merge).toBe("conflicts")
    expect(parsePrRow(node({ mergeStateStatus: "UNKNOWN" }))!.merge).toBe("unknown")
    expect(parsePrRow(node({ commits: { nodes: [] } }))!.ci).toBeNull()
  })

  it("reviewers with their latest review; requested users and teams", () => {
    const r = parsePrRow(
      node({
        latestOpinionatedReviews: {
          nodes: [
            { author: { login: "a" }, state: "APPROVED" },
            { author: { login: "b" }, state: "CHANGES_REQUESTED" },
            { author: null, state: "APPROVED" }, // a deleted user
          ],
        },
        reviewRequests: {
          nodes: [
            { requestedReviewer: { login: "c" } },
            { requestedReviewer: { combinedSlug: "o/core" } },
            {},
          ],
        },
      }),
    )!
    expect(r.reviewers).toEqual([
      { login: "a", state: "approved" },
      { login: "b", state: "changes" },
    ])
    expect(r.requested).toEqual(["c", "o/core"])
  })

  it("not a PR (an empty search node), or garbage: null", () => {
    expect(parsePrRow({})).toBeNull()
    expect(parsePrRow(null)).toBeNull()
    expect(parsePrRow({ number: "7", url: "x" })).toBeNull()
  })
})

describe("parsePrLists", () => {
  const answer = (data: unknown) => JSON.stringify({ data })

  it("each tab's rows and the API budget", () => {
    const out = answer({
      mine: { nodes: [node(), {}] },
      review: { nodes: [] },
      repo: { nodes: [node({ number: 8 })] },
      rateLimit: { remaining: 4900, resetAt: "2026-10-14T10:00:00Z" },
    })
    const l = parsePrLists(out, true)!
    expect(l.mine.map((r) => r.number)).toEqual([7])
    expect(l.review).toEqual([])
    expect(l.repo!.map((r) => r.number)).toEqual([8])
    expect(l.remaining).toBe(4900)
    expect(parsePrLists(out, false)!.repo).toBeUndefined()
  })

  it("not an answer: null, never a throw", () => {
    expect(parsePrLists("nope", true)).toBeNull()
    expect(parsePrLists(JSON.stringify({ errors: [{}] }), true)).toBeNull()
  })
})

describe("prSearches", () => {
  const now = Date.parse("2026-10-14T12:00:00Z")
  it("open PRs, or any updated in the last 14 days", () => {
    expect(prSearches("o/r", false, now)).toEqual({
      mine: "is:pr is:open author:@me sort:updated-desc",
      review: "is:pr is:open review-requested:@me sort:updated-desc",
      repo: "is:pr is:open repo:o/r sort:updated-desc",
    })
    expect(prSearches(undefined, true, now).mine).toBe(
      "is:pr updated:>=2026-09-30 author:@me sort:updated-desc",
    )
    expect(prSearches(undefined, false, now).repo).toBe("")
  })
})

describe("githubRepoOf", () => {
  it("https, ssh and scp-like remotes; not other hosts", () => {
    expect(githubRepoOf("https://github.com/o/r.git")).toBe("o/r")
    expect(githubRepoOf("https://x-token@github.com/o/r")).toBe("o/r")
    expect(githubRepoOf("git@github.com:o/r.git")).toBe("o/r")
    expect(githubRepoOf("ssh://git@github.com/o/r.git")).toBe("o/r")
    expect(githubRepoOf("git@gitlab.com:o/r.git")).toBeNull()
    expect(githubRepoOf("https://github.com/o")).toBeNull()
  })
})

describe("statusParts", () => {
  const row = (over: Partial<PrRow> = {}) => ({ ...parsePrRow(node())!, ...over })
  it("what the row says, in reading order", () => {
    expect(statusParts(row())).toEqual(["CI passed", "3 comments"])
    expect(
      statusParts(
        row({ state: "draft", review: "changes", merge: "behind", ci: "failure", comments: 1 }),
      ),
    ).toEqual(["draft", "changes requested", "behind base", "CI failing", "1 comment"])
    expect(statusParts(row({ requested: ["a"], review: "required", comments: 0 }))).toEqual([
      "review requested",
      "CI passed",
    ])
    expect(statusParts(row({ state: "merged", merge: "behind", comments: 0 }))).toEqual(["merged"])
    expect(statusParts(row({ merge: "unknown", comments: 0, ci: null }))).toEqual([])
  })
})

describe("nextRefreshMs", () => {
  it("every minute; backs off on errors; waits for the reset when the budget is low", () => {
    expect(nextRefreshMs(null, 0)).toBe(60_000)
    expect(nextRefreshMs(null, 1)).toBe(60_000)
    expect(nextRefreshMs(null, 3)).toBe(240_000)
    expect(nextRefreshMs(null, 9)).toBe(300_000)
    const now = Date.parse("2026-10-14T10:00:00Z")
    const low = { mine: [], review: [], remaining: 100, resetAt: "2026-10-14T10:20:00Z" }
    expect(nextRefreshMs(low, 0, now)).toBe(20 * 60_000)
    expect(nextRefreshMs({ ...low, remaining: 4000 }, 0, now)).toBe(60_000)
  })
})

describe("tabFor", () => {
  const tabs = ["mine", "review", "repo"] as const
  it("1/2/3 and ←/→, within the tabs shown", () => {
    expect(tabFor("2", "mine", [...tabs])).toBe("review")
    expect(tabFor("3", "mine", ["mine", "review"])).toBeNull()
    expect(tabFor("ArrowRight", "repo", [...tabs])).toBe("mine")
    expect(tabFor("ArrowLeft", "mine", [...tabs])).toBe("repo")
    expect(tabFor("x", "mine", [...tabs])).toBeNull()
  })
})

describe("mergePart", () => {
  const row = (n: number) => parsePrRow({ number: n, url: `u${n}`, state: "OPEN" })!
  const ok = (lists: Partial<PrLists>): PrListsResult => ({
    ok: true,
    lists: { mine: [], review: [], ...lists },
  })

  it("each tab's answer goes in its own place; the others keep theirs", () => {
    let l = mergePart(null, "review", ok({ review: [row(2)], remaining: 4000 }))!
    expect(l.review.map((r) => r.number)).toEqual([2])
    expect(l.answered).toEqual({ review: true })
    l = mergePart(l, "mine", ok({ mine: [row(1)], remaining: 3000 }))!
    expect([l.mine.length, l.review.length, l.remaining]).toEqual([1, 1, 3000])
    l = mergePart(l, "repo", ok({ repo: [row(3)], repoName: "o/r", repoVisible: true }))!
    expect([l.repoName, l.repo?.length, l.answered]).toEqual([
      "o/r",
      1,
      { review: true, mine: true, repo: true },
    ])
    // no repo here now: the repo's fields go, the others stay
    l = mergePart(l, "repo", ok({}))!
    expect([l.repoName, l.repo, l.mine.length]).toEqual([undefined, undefined, 1])
  })

  it("a tab's failure: answered, with its own note; notes join", () => {
    const failed = mergePart(null, "repo", { ok: false, error: "offline" })!
    expect([failed.answered, failed.warning]).toEqual([{ repo: true }, "Can't reach GitHub."])
    let l = mergePart(null, "mine", ok({ mine: [row(1)], warning: "w1" }))!
    l = mergePart(l, "review", { ok: false, error: "failed", message: "boom" })!
    expect(l.warning).toBe("w1 gh couldn't load this from GitHub. boom")
    l = mergePart(l, "mine", ok({ mine: [row(1)] }))!
    expect(l.warning).toBe("gh couldn't load this from GitHub. boom")
  })

  it("accounts pending, until an answer that knows them", () => {
    let l = mergePart(null, "mine", ok({ accountsPending: true }))!
    expect(l.accountsPending).toBe(true)
    l = mergePart(l, "mine", ok({ accounts: [{ login: "me", active: true, ok: true }] }))!
    expect([l.accountsPending, l.accounts?.length]).toEqual([undefined, 1])
  })
})

describe("mergePart rate limit", () => {
  const ok = (remaining: number, resetAt: string): PrListsResult => ({
    ok: true,
    lists: { mine: [], review: [], remaining, resetAt },
  })
  it("a new hour's reading replaces the last; within the hour, the lowest", () => {
    let l = mergePart(null, "mine", ok(100, "R1"))!
    l = mergePart(l, "review", ok(300, "R1"))!
    expect([l.remaining, l.resetAt]).toEqual([100, "R1"])
    l = mergePart(l, "mine", ok(400, "R2"))!
    expect([l.remaining, l.resetAt]).toEqual([400, "R2"])
  })
})

describe("openOnly", () => {
  const r = (n: number, state: PrRow["state"]) => ({ url: `u${n}`, state }) as PrRow
  it("leaves out closed and merged PRs; the same lists when there are none", () => {
    const lists = {
      mine: [r(1, "open"), r(2, "closed")],
      review: [r(3, "merged")],
      repo: [r(4, "draft")],
    }
    expect(openOnly(lists)).toEqual({ mine: [r(1, "open")], review: [], repo: [r(4, "draft")] })
    const open = { mine: [r(1, "open")], review: [] }
    expect(openOnly(open)).toBe(open)
  })
})
