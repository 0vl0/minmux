import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { PrDetailView } from "./pr-detail-view"
import { ipc } from "../lib/ipc"
import type { PrRow } from "../lib/pr-dashboard"
import type { PrDetail } from "../lib/pr-detail"

const row = (n: number, updatedAt = "t1"): PrRow => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  repo: "o/r",
  author: "me",
  state: "open",
  head: "b",
  base: "main",
  review: null,
  reviewers: [],
  requested: [],
  merge: "clean",
  ci: null,
  comments: 0,
  additions: 0,
  deletions: 0,
  updatedAt,
})

const detail = (n: number, over: Partial<PrDetail> = {}): PrDetail => ({
  url: row(n).url,
  updatedAt: "t1",
  body: "The description, see https://x.io",
  conversation: [
    { kind: "review", author: "alice", body: "Looks good", at: "", url: "r1", state: "approved" },
  ],
  threads: [
    {
      path: "src/a.ts",
      line: 12,
      resolved: false,
      outdated: false,
      hunk: "@@ -1 +1 @@\n-old\n+new",
      comments: [{ author: "bob", body: "Rename this?", at: "", url: "c1" }],
    },
    {
      path: "src/a.ts",
      line: 3,
      resolved: true,
      outdated: false,
      hunk: "",
      comments: [{ author: "bob", body: "Done", at: "", url: "c2" }],
    },
  ],
  more: false,
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe("PrDetailView", () => {
  it("description, review threads by file with their lines, and the conversation", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(1) })
    render(<PrDetailView row={row(1)} env={{ cwd: "/w" }} />)
    expect(await screen.findByText("Rename this?")).toBeInTheDocument()
    expect(ipc.prDetail).toHaveBeenCalledWith({ repo: "o/r", number: 1, cwd: "/w", wsl: undefined })
    expect(screen.getByText(/Review threads \(2, 1 open\)/)).toBeInTheDocument()
    expect(screen.getByText("+new")).toBeInTheDocument()
    expect(screen.getByText("Looks good")).toBeInTheDocument()
    fireEvent.click(screen.getByText("https://x.io"))
    expect(ipc.openExternal).toHaveBeenCalledWith("https://x.io")
  })

  it("open in the editor at the thread's line, when this PR's repo is checked out", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(2) })
    vi.mocked(ipc.pathExists).mockResolvedValue(true)
    render(<PrDetailView row={row(2)} env={{}} checkout="/w/r" />)
    await screen.findByText("Rename this?")
    fireEvent.click(screen.getAllByTitle("Open in editor at this line")[0]!)
    await waitFor(() => expect(ipc.openFile).toHaveBeenCalledWith("/w/r", "src/a.ts", 12))
  })

  it("no checkout of it: no editor button", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(3) })
    render(<PrDetailView row={row(3)} env={{}} />)
    await screen.findByText("Rename this?")
    expect(screen.queryByTitle("Open in editor at this line")).toBeNull()
  })

  it("an unchanged PR comes from the cache; a changed one is asked again", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: true, detail: detail(4) })
    const first = render(<PrDetailView row={row(4)} env={{}} />)
    await screen.findByText("Rename this?")
    first.unmount()
    render(<PrDetailView row={row(4)} env={{}} />)
    expect(screen.getByText("Rename this?")).toBeInTheDocument() // at once
    await new Promise((r) => setTimeout(r, 300))
    expect(ipc.prDetail).toHaveBeenCalledTimes(1)
  })

  it("a failure says so", async () => {
    vi.mocked(ipc.prDetail).mockResolvedValue({ ok: false, error: "offline" })
    render(<PrDetailView row={row(5)} env={{}} />)
    expect(await screen.findByText(/Couldn't load the comments/)).toBeInTheDocument()
  })
})
