import { beforeEach, describe, expect, it, vi } from "vitest"
import { ipc } from "../lib/ipc"
import type { PrRow } from "../lib/pr-dashboard"
import { HELD_MS } from "../lib/pr-reviewers"
import { editError, editReviewer, heldRows, prEdit, resetPrEdits } from "./pr-edits"

const pr = (over: Partial<PrRow> = {}): PrRow => ({
  number: 7,
  title: "t",
  url: "https://github.com/o/r/pull/7",
  repo: "o/r",
  author: "me",
  state: "open",
  head: "h",
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
  updatedAt: "2026-10-14T09:00:00Z",
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  resetPrEdits()
})

describe("pr-edits", () => {
  it("a change: busy while gh runs, then the PR's own row (kept at most a while)", async () => {
    let done: (r: Awaited<ReturnType<typeof ipc.prReviewers>>) => void = () => {}
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise((r) => (done = r)))
    const p = editReviewer(pr(), "ann", true, { cwd: "/w" })
    expect(prEdit(pr().url)?.busy).toEqual({ login: "ann", add: true })
    await editReviewer(pr(), "bob", true, {}) // one change per PR at a time
    expect(ipc.prReviewers).toHaveBeenCalledTimes(1)
    expect(ipc.prReviewers).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/w" }))
    done({ ok: true, row: pr({ requested: ["ann"] }) })
    await p
    expect(prEdit(pr().url)?.busy).toBeNull()
    expect(heldRows()).toEqual([pr({ requested: ["ann"] })])
    expect(heldRows(Date.now() + HELD_MS)).toEqual([])
  })

  it("gh refused: the error, for a while; no row", async () => {
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: false, error: "failed", message: "no" })
    await editReviewer(pr(), "ann", true, {})
    expect(editError(prEdit(pr().url))).toMatch(/no$/)
    expect(editError(prEdit(pr().url), Date.now() + 3 * 60_000)).toBeNull()
    expect(heldRows()).toEqual([])
  })

  it("the change went through, the PR couldn't be asked for: guessed from the row shown", async () => {
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: null })
    await editReviewer(pr({ requested: ["bob"] }), "ann", true, {})
    expect(heldRows()[0]!.requested).toEqual(["bob", "ann"])
  })
})
