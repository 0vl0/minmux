import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { PrDialog } from "./pr-dialog"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"
import type { PrLists, PrRow } from "../lib/pr-dashboard"
import { resetPrEdits } from "./pr-edits"

const st = () => useStore.getState()
const lastCall = () => {
  const calls = vi.mocked(ipc.prLists).mock.calls
  return calls[calls.length - 1]![0]
}

const row = (n: number, over: Partial<PrRow> = {}): PrRow => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  repo: "o/r",
  author: "me",
  state: "open",
  head: `b${n}`,
  fork: false,
  base: "main",
  review: null,
  reviewers: [],
  requested: [],
  merge: "clean",
  ci: null,
  comments: 0,
  additions: 1,
  deletions: 0,
  updatedAt: "",
  ...over,
})

const answer = (lists: Partial<PrLists>) =>
  vi.mocked(ipc.prLists).mockResolvedValue({ ok: true, lists: { mine: [], review: [], ...lists } })

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  localStorage.clear()
  resetPrEdits()
  st().newTab(testShell)
  st().setPrDialogOpen(true)
})

describe("PrDialog", () => {
  it("asks for the focused pane's checkout and lists my PRs with their status", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/r", branch: "b1" } }, [id])
    answer({ mine: [row(1, { review: "approved", ci: "success" }), row(2, { state: "draft" })] })
    render(<PrDialog />)
    expect(await screen.findByRole("option", { name: /PR 1/ })).toBeInTheDocument()
    expect(ipc.prLists).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/w/r", closed: false }),
    )
    expect(screen.getAllByText("approved").length).toBeGreaterThan(0)
    expect(screen.getByText("draft")).toBeInTheDocument()
  })

  it("tabs: the repo tab is named after the repo; keys switch and move", async () => {
    answer({ mine: [row(1)], review: [row(2)], repo: [row(3), row(4)], repoName: "o/r" })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    const dialog = screen.getByRole("dialog")
    fireEvent.keyDown(dialog, { key: "3" })
    expect(screen.getByRole("tab", { name: /o\/r/ })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("option", { name: /PR 3/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(dialog, { key: "j" })
    expect(screen.getByRole("option", { name: /PR 4/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(dialog, { key: "o" })
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/4")
  })

  it("no repo tab without a GitHub repo", async () => {
    answer({ mine: [row(1)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    expect(screen.getAllByRole("tab")).toHaveLength(2)
  })

  it("gh missing or logged out: says what to do", async () => {
    vi.mocked(ipc.prLists).mockResolvedValue({ ok: false, error: "unauthenticated" })
    render(<PrDialog />)
    expect(await screen.findByText(/gh auth login/)).toBeInTheDocument()
  })

  it("a PR checked out in a pane links to it", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/r", pr: { number: 1, state: "open", url: row(1).url } } }, [
      id,
    ])
    answer({ mine: [row(1)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    fireEvent.click(screen.getByTitle("Go to this terminal"))
    expect(st().prDialogOpen).toBe(false)
  })

  it("a toggle while a refresh runs: asked again at once, the old answer dropped", async () => {
    let finish: (v: Awaited<ReturnType<typeof ipc.prLists>>) => void = () => {}
    vi.mocked(ipc.prLists).mockImplementationOnce(() => new Promise((r) => (finish = r)))
    answer({ mine: [row(9)] })
    render(<PrDialog />)
    fireEvent.click(screen.getByRole("checkbox"))
    await act(async () => finish({ ok: true, lists: { mine: [row(1)], review: [] } }))
    expect(await screen.findByRole("option", { name: /PR 9/ })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /PR 1\b/ })).toBeNull()
    expect(lastCall()).toMatchObject({ closed: true })
  })

  it("Enter on a focused button is the button's, not 'open on GitHub'", async () => {
    answer({ mine: [row(1)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    fireEvent.keyDown(screen.getByTitle("Refresh (r)"), { key: "Enter" })
    expect(ipc.openExternal).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole("checkbox"), { key: "Escape" })
    expect(st().prDialogOpen).toBe(false)
  })

  it("with a button focused, the dialog's keys still work; app shortcuts aren't taken", async () => {
    answer({ mine: [row(1), row(2)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    const tab = screen.getByRole("tab", { name: /Review/ })
    fireEvent.keyDown(tab, { key: "j" })
    expect(screen.getByRole("option", { name: /PR 2/ })).toHaveAttribute("aria-selected", "true")
    fireEvent.keyDown(tab, { key: "k", metaKey: true })
    expect(screen.getByRole("option", { name: /PR 2/ })).toHaveAttribute("aria-selected", "true")
  })

  it("the selection follows its PR when a refresh reorders the list", async () => {
    answer({ mine: [row(1), row(2), row(3)] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 1/ })
    fireEvent.click(screen.getByRole("option", { name: /PR 3/ }))
    answer({ mine: [row(3), row(1), row(2)] })
    fireEvent.click(screen.getByTitle("Refresh (r)"))
    await waitFor(() => expect(screen.getAllByRole("option")[0]).toHaveAccessibleName(/PR 3/))
    expect(screen.getByRole("option", { name: /PR 3/ })).toHaveAttribute("aria-selected", "true")
  })

  it("reopened from another repo: the last answer isn't shown as this one's", async () => {
    const id = st().tabs[0]!.activeSessionId
    st().setPaneGit({ [id]: { root: "/w/a" } }, [id])
    answer({ mine: [], repo: [row(1)], repoName: "o/a" })
    const first = render(<PrDialog />)
    await screen.findByRole("tab", { name: /o\/a/ })
    first.unmount()
    st().setPaneGit({ [id]: { root: "/w/b" } }, [id])
    vi.mocked(ipc.prLists).mockImplementation(() => new Promise(() => {})) // still loading
    render(<PrDialog />)
    expect(screen.queryByRole("tab", { name: /o\/a/ })).toBeNull()
  })

  it("logged out: no more automatic tries", async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(ipc.prLists).mockResolvedValue({ ok: false, error: "unauthenticated" })
      render(<PrDialog />)
      await act(async () => {})
      await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000))
      expect(ipc.prLists).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("threads open in the editor only from a checkout of that PR's branch, at its root", async () => {
    const id = st().tabs[0]!.activeSessionId
    const thread = {
      path: "a.ts",
      line: 3,
      resolved: false,
      outdated: false,
      removed: false,
      hunk: "",
      comments: [],
    }
    const detail = {
      url: row(1).url,
      updatedAt: "",
      body: "",
      conversation: [],
      threads: [thread],
      more: false,
    }
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail })
    answer({ mine: [row(1)], repo: [], repoName: "O/R" }) // the remote's spelling of o/r
    st().setPaneGit({ [id]: { root: "/w/r", branch: "main" } }, [id])
    const view = render(<PrDialog />)
    await screen.findByText("line 3")
    expect(screen.queryByTitle("Open in editor at this line")).toBeNull() // on main, not b1
    view.unmount()
    st().setPaneGit({ [id]: { root: "/w/r", branch: "b1" } }, [id])
    const again = render(<PrDialog />)
    await screen.findByText("line 3")
    expect(screen.getByTitle("Open in editor at this line")).toBeInTheDocument()
    again.unmount()
    answer({ mine: [row(1, { fork: true })], repo: [], repoName: "o/r" }) // from a fork's b1
    render(<PrDialog />)
    await screen.findByText("line 3")
    expect(screen.queryByTitle("Open in editor at this line")).toBeNull()
  })

  it("Esc closes; nothing is asked after", async () => {
    answer({ mine: [] })
    render(<PrDialog />)
    await waitFor(() => expect(ipc.prLists).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(st().prDialogOpen).toBe(false)
  })

  it("refreshes every minute while open", async () => {
    vi.useFakeTimers()
    try {
      answer({ mine: [] })
      render(<PrDialog />)
      await act(async () => {})
      expect(ipc.prLists).toHaveBeenCalledTimes(1)
      await act(async () => vi.advanceTimersByTimeAsync(60_000))
      expect(ipc.prLists).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("PrDialog reviewers", () => {
  const cand = (login: string, over = {}) => ({
    login,
    name: "",
    team: false,
    suggested: false,
    ...over,
  })

  it("the picker: suggestions first, a click requests, the PR's fresh row shows it", async () => {
    const pr = row(41, { updatedAt: "2026-10-14T09:00:00Z" })
    answer({ mine: [pr] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: {
        suggested: [cand("ann", { suggested: true })],
        people: [cand("me"), cand("bob", { name: "Bob B" })],
        teams: "no-scope",
      },
    })
    const fresh = { ...pr, requested: ["bob"], updatedAt: "2026-10-14T10:00:00Z" }
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: fresh })
    render(<PrDialog />)
    fireEvent.click(await screen.findByRole("button", { name: /Request reviewer/ }))
    const picker = await screen.findByRole("listbox", { name: "Reviewers" })
    await waitFor(() => expect(picker.querySelectorAll("[role=option]")).toHaveLength(2))
    expect(picker.textContent).toMatch(/ann.*suggested.*bob.*Bob B/)
    expect(screen.getByText("gh auth refresh -s read:org")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("option", { name: /bob/ }))
    await waitFor(() =>
      expect(ipc.prReviewers).toHaveBeenCalledWith(
        expect.objectContaining({ repo: "o/r", number: 41, add: ["bob"], remove: [] }),
      ),
    )
    expect(await screen.findByTitle("Remove the review request for bob")).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /bob/ })).toHaveAttribute("aria-disabled", "true")
  })

  it("typing searches (the dialog's keys stay out of it); Esc closes the picker only", async () => {
    answer({ mine: [row(42), row(43)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [], teams: null },
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 42/ }) // not the last test's answer
    fireEvent.click(await screen.findByRole("button", { name: /Request reviewer/ }))
    const input = screen.getByRole("textbox", { name: "Search reviewers" })
    fireEvent.keyDown(input, { key: "j" })
    fireEvent.change(input, { target: { value: "jo" } })
    expect(screen.getByRole("option", { name: /PR 42/ })).toHaveAttribute("aria-selected", "true")
    await waitFor(() =>
      expect(ipc.prCandidates).toHaveBeenLastCalledWith(expect.objectContaining({ query: "jo" })),
    )
    fireEvent.keyDown(input, { key: "Escape" })
    expect(screen.queryByRole("textbox", { name: "Search reviewers" })).toBeNull()
    expect(st().prDialogOpen).toBe(true)
  })

  it("a pending request is removed by its ✕; gh's refusal is shown", async () => {
    answer({ mine: [row(44, { requested: ["bob"] })] })
    vi.mocked(ipc.prReviewers).mockResolvedValue({
      ok: false,
      error: "failed",
      message: "not allowed",
    })
    render(<PrDialog />)
    fireEvent.click(await screen.findByTitle("Remove the review request for bob"))
    expect(await screen.findByText(/not allowed/)).toBeInTheDocument()
    expect(ipc.prReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ number: 44, add: [], remove: ["bob"] }),
    )
  })

  it("the change went through but the PR couldn't be asked for again: shown anyway", async () => {
    answer({ mine: [row(46, { updatedAt: "2026-10-14T09:00:00Z" })] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [cand("bob")], teams: null },
    })
    vi.mocked(ipc.prReviewers).mockResolvedValue({ ok: true, row: null })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 46/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    fireEvent.click(await screen.findByRole("option", { name: /bob/ }))
    expect(await screen.findByTitle("Remove the review request for bob")).toBeInTheDocument()
  })

  it("an edit answered after moving to another PR still shows, over older list copies", async () => {
    let answerEdit: (r: Awaited<ReturnType<typeof ipc.prReviewers>>) => void = () => {}
    const pr = row(47, { updatedAt: "2026-10-14T09:00:00Z", ci: "pending" })
    answer({ mine: [pr, row(48)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [cand("bob")], teams: null },
    })
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise((r) => (answerEdit = r)))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 47/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    fireEvent.click(await screen.findByRole("option", { name: /bob/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 48/ }))
    const fresh = { ...pr, requested: ["bob"], updatedAt: "2026-10-14T10:00:00Z" }
    await act(async () => answerEdit({ ok: true, row: fresh }))
    fireEvent.click(screen.getByRole("option", { name: /PR 47/ }))
    expect(await screen.findByTitle("Remove the review request for bob")).toBeInTheDocument()
    // a lagging list copy (older) keeps the change; one as new (CI moved on) is the list's
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "r" })
    await waitFor(() => expect(ipc.prLists).toHaveBeenCalledTimes(2))
    expect(await screen.findByTitle("Remove the review request for bob")).toBeInTheDocument()
    answer({ mine: [{ ...fresh, ci: "success" }, row(48)] })
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "r" })
    expect((await screen.findAllByText("CI passed")).length).toBeGreaterThan(0)
    answer({ mine: [{ ...fresh, requested: [], updatedAt: "2026-10-14T11:00:00Z" }, row(48)] })
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "r" })
    await waitFor(() => expect(screen.queryByTitle("Remove the review request for bob")).toBeNull())
  })

  it("a reviewer asked again after reviewing can be un-asked", async () => {
    answer({
      mine: [row(49, { reviewers: [{ login: "bob", state: "approved" }], requested: ["bob"] })],
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 49/ })
    expect(screen.getByTitle("Remove the review request for bob")).toBeInTheDocument()
  })

  it("closing the picker gives the keys back to the dialog", async () => {
    answer({ mine: [row(50), row(51)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [], teams: null },
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 50/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    const input = screen.getByRole("textbox", { name: "Search reviewers" })
    input.focus()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(document.activeElement).toBe(screen.getByRole("dialog"))
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    expect(st().prDialogOpen).toBe(false)
  })

  it("a double click sends one change", async () => {
    answer({ mine: [row(52)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [cand("bob")], teams: null },
    })
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise(() => {}))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 52/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    const bob = await screen.findByRole("option", { name: /bob/ })
    fireEvent.click(bob)
    fireEvent.click(bob)
    expect(ipc.prReviewers).toHaveBeenCalledTimes(1)
  })

  it("a click on someone keeps the focus in the search box", async () => {
    answer({ mine: [row(53)] })
    vi.mocked(ipc.prCandidates).mockResolvedValue({
      ok: true,
      candidates: { suggested: [], people: [cand("bob")], teams: null },
    })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 53/ })
    fireEvent.click(screen.getByRole("button", { name: /Request reviewer/ }))
    const bob = await screen.findByRole("option", { name: /bob/ })
    expect(fireEvent.mouseDown(bob)).toBe(false) // default (moving the focus) prevented
  })

  it("an edit's failure still shows after moving away and back", async () => {
    let fail: (r: Awaited<ReturnType<typeof ipc.prReviewers>>) => void = () => {}
    answer({ mine: [row(54, { requested: ["bob"] }), row(55)] })
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise((r) => (fail = r)))
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 54/ })
    fireEvent.click(screen.getByTitle("Remove the review request for bob"))
    fireEvent.click(screen.getByRole("option", { name: /PR 55/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 54/ }))
    expect(screen.getByTitle("Remove the review request for bob")).toBeDisabled() // still running
    await act(async () => fail({ ok: false, error: "failed", message: "not allowed" }))
    fireEvent.click(screen.getByRole("option", { name: /PR 55/ }))
    fireEvent.click(screen.getByRole("option", { name: /PR 54/ }))
    expect(screen.getByText(/not allowed/)).toBeInTheDocument()
  })

  it("an edit that lands after the dialog was closed and reopened shows there", async () => {
    let done: (r: Awaited<ReturnType<typeof ipc.prReviewers>>) => void = () => {}
    const pr = row(56, { requested: ["bob"], updatedAt: "2026-10-14T09:00:00Z" })
    answer({ mine: [pr] })
    vi.mocked(ipc.prReviewers).mockReturnValue(new Promise((r) => (done = r)))
    const first = render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 56/ })
    fireEvent.click(screen.getByTitle("Remove the review request for bob"))
    first.unmount()
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 56/ })
    const fresh = { ...pr, requested: [], updatedAt: "2026-10-14T10:00:00Z" }
    await act(async () => done({ ok: true, row: fresh }))
    expect(screen.queryByTitle("Remove the review request for bob")).toBeNull()
  })

  it("merged or closed: no requests", async () => {
    answer({ mine: [row(45, { state: "merged", requested: ["bob"] })] })
    render(<PrDialog />)
    await screen.findByRole("option", { name: /PR 45/ })
    expect(screen.queryByRole("button", { name: /Request reviewer/ })).toBeNull()
    expect(screen.queryByTitle(/Remove the review request/)).toBeNull()
  })
})
