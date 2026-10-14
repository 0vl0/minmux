import { beforeEach, describe, expect, it, vi } from "vitest"
import { ipc } from "../lib/ipc"
import type { PrRow } from "../lib/pr-dashboard"
import { EDIT_HOLD_MS } from "../lib/pr-reviewers"
import { editError, editReviewer, heldRows, prEdit, refetchEdited, resetPrEdits } from "./pr-edits"

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
  updatedAt: "",
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  resetPrEdits()
})

describe("pr-edits", () => {
  it("a change: busy while gh runs, then the PR's own row held for a while", async () => {
    let done: (r: Awaited<ReturnType<typeof ipc.prReviewers>>) => void = () => {}
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise((r) => (done = r)))
    const p = editReviewer(pr(), "ann", true, { cwd: "/w" })
    expect(prEdit(pr().url)?.busy).toEqual({ login: "ann", add: true })
    await editReviewer(pr(), "bob", true, {}) // one change per PR at a time
    expect(ipc.prReviewers).toHaveBeenCalledTimes(1)
    done({ ok: true, row: pr({ requested: ["ann"] }) })
    await p
    expect(prEdit(pr().url)?.busy).toBeNull()
    expect(heldRows()).toEqual([pr({ requested: ["ann"] })])
    expect(heldRows(Date.now() + EDIT_HOLD_MS)).toEqual([])
  })

  it("gh refused: the error, for a while; no row", async () => {
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: false, error: "failed", message: "no" })
    await editReviewer(pr(), "ann", true, {})
    expect(editError(prEdit(pr().url))).toMatch(/no$/)
    expect(editError(prEdit(pr().url), Date.now() + EDIT_HOLD_MS)).toBeNull()
    expect(heldRows()).toEqual([])
  })

  it("the change went through, the PR couldn't be asked for: guessed from the last row", async () => {
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: null })
    await editReviewer(pr({ requested: ["bob"] }), "ann", true, {})
    await editReviewer(pr({ requested: ["bob"] }), "bob", false, {})
    expect(heldRows()[0]!.requested).toEqual(["ann"])
  })

  it("asked for again after a refresh; an answer older than a newer change is dropped", async () => {
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: pr({ requested: ["ann"] }) })
    await editReviewer(pr(), "ann", true, {})
    let answer: (r: PrRow | null) => void = () => {}
    vi.mocked(ipc.prRow).mockReturnValue(new Promise((r) => (answer = r)))
    refetchEdited({ cwd: "/w" })
    expect(ipc.prRow).toHaveBeenCalledWith({ repo: "o/r", number: 7, cwd: "/w" })
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: pr({ requested: [] }) })
    await editReviewer(pr(), "ann", false, {})
    answer(pr({ requested: ["ann"], ci: "success" }))
    await new Promise((r) => setTimeout(r))
    expect(heldRows()[0]!.requested).toEqual([])
  })
})
