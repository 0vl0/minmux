import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { PrDialog } from "./pr-dialog"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"
import type { PrLists, PrRow } from "../lib/pr-dashboard"

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
