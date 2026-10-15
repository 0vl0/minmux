import { useState } from "react"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { AgentProcesses, LeftRunning } from "./agent-processes"
import { useAgentProcesses } from "./use-agent-processes"
import { ipc } from "../lib/ipc"
import type { AgentProc } from "../lib/agent-processes"

const proc = (o: Partial<AgentProc>): AgentProc => ({
  pid: 120,
  ppid: 110,
  command: "/usr/bin/npm test",
  comm: "npm",
  cpu: 0,
  rssKb: 2048,
  started: Date.now() - 60_000,
  depth: 0,
  ...o,
})

// As the agents panel wires it: one poll for every open list.
function Lists({ panes }: { panes: string[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const result = useAgentProcesses(open, false)
  return (
    <>
      {panes.map((id) => (
        <div key={id} data-testid={id}>
          <AgentProcesses
            paneId={id}
            open={open.has(id)}
            onToggle={() =>
              setOpen((s) => {
                const n = new Set(s)
                if (n.has(id)) n.delete(id)
                else n.add(id)
                return n
              })
            }
            result={result}
          />
        </div>
      ))}
    </>
  )
}

const toggle = (pane = "p") =>
  fireEvent.click(screen.getByTestId(pane).querySelector(".agent-procs-toggle")!)

describe("AgentProcesses", () => {
  beforeEach(() => vi.clearAllMocks())

  it("asks nothing while every list is closed", async () => {
    render(<Lists panes={["p"]} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(ipc.agentProcesses).not.toHaveBeenCalled()
  })

  it("open: the processes as a tree with CPU, memory and age; the count on the row", async () => {
    vi.mocked(ipc.agentProcesses).mockResolvedValue({
      panes: {
        p: [
          proc({}),
          proc({
            pid: 121,
            ppid: 120,
            command: "node /w/vitest run",
            comm: "node",
            cpu: 51.4,
            depth: 1,
          }),
          proc({ pid: 300, ppid: 1, command: "node server.js", comm: "node", detached: true }),
        ],
      },
    })
    render(<Lists panes={["p"]} />)
    toggle()
    expect(await screen.findByText("npm test")).toBeInTheDocument()
    expect(screen.getByText("node /w/vitest run")).toBeInTheDocument()
    expect(screen.getByText("51%")).toBeInTheDocument()
    expect(screen.getByText("(detached)")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /3 processes · 51% CPU/ })).toBeInTheDocument()
  })

  it("closed again: no stale count", async () => {
    vi.mocked(ipc.agentProcesses).mockResolvedValue({ panes: { p: [proc({ cpu: 90 })] } })
    render(<Lists panes={["p"]} />)
    toggle()
    await screen.findByText("npm test")
    toggle()
    expect(screen.getByRole("button", { name: "processes" })).toBeInTheDocument()
  })

  it("two lists open: one request for both panes", async () => {
    vi.mocked(ipc.agentProcesses).mockResolvedValue({ panes: { a: [proc({})], b: [] } })
    render(<Lists panes={["a", "b"]} />)
    toggle("a")
    await waitFor(() => expect(ipc.agentProcesses).toHaveBeenCalledWith(["a"]))
    toggle("b")
    await waitFor(() => expect(ipc.agentProcesses).toHaveBeenLastCalledWith(["a", "b"]))
  })

  it("says when the processes couldn't be read, and when nothing runs", async () => {
    vi.mocked(ipc.agentProcesses).mockResolvedValueOnce({ panes: {}, failed: true })
    const { unmount } = render(<Lists panes={["p"]} />)
    toggle()
    expect(await screen.findByText("Couldn't read the processes.")).toBeInTheDocument()
    unmount()
    vi.mocked(ipc.agentProcesses).mockResolvedValue({ panes: { p: [] } })
    render(<Lists panes={["p"]} />)
    toggle()
    expect(await screen.findByText("Nothing running.")).toBeInTheDocument()
  })

  it("a listening port opens in the browser", async () => {
    vi.mocked(ipc.agentProcesses).mockResolvedValue({ panes: { p: [proc({ ports: [5173] })] } })
    render(<Lists panes={["p"]} />)
    toggle()
    fireEvent.click(await screen.findByTitle("Open http://localhost:5173 in the browser"))
    expect(ipc.openExternal).toHaveBeenCalledWith("http://localhost:5173")
  })
})

describe("LeftRunning", () => {
  beforeEach(() => vi.clearAllMocks())

  it("nothing when nothing was left running", () => {
    const { container } = render(
      <LeftRunning result={{ panes: {}, leftovers: {} }} label={() => "x"} />,
    )
    expect(container.textContent).toBe("")
  })

  it("per pane, what its agents left running, and how to end it", () => {
    render(
      <LeftRunning
        result={{
          panes: {},
          leftovers: {
            gone: [
              proc({ pid: 300, command: "node server.js", comm: "node", detached: true }),
              proc({
                pid: 301,
                ppid: 300,
                command: "node worker.js",
                comm: "node",
                depth: 1,
                detached: true,
              }),
            ],
          },
        }}
        label={(id) => (id === "gone" ? "A closed pane" : id)}
      />,
    )
    expect(screen.getByText("Left running")).toBeInTheDocument()
    expect(screen.getByText("A closed pane")).toBeInTheDocument()
    expect(screen.getByText("node server.js")).toBeInTheDocument()
    // Listing only: ending one is the user's call, the hover says how.
    expect(screen.queryByRole("button", { name: "End all" })).toBeNull()
    expect(screen.getByTitle(/To end it: kill 300$/)).toBeInTheDocument()
  })
})

describe("useAgentProcesses: leftovers only", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.useRealTimers())

  it("with no list open, asks every 10 s while leftovers are wanted", async () => {
    vi.useFakeTimers()
    vi.mocked(ipc.agentProcesses).mockResolvedValue({ panes: {}, leftovers: {} })
    function Probe() {
      useAgentProcesses(new Set(), true)
      return null
    }
    render(<Probe />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(ipc.agentProcesses).toHaveBeenCalledWith([])
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(ipc.agentProcesses).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(5100))
    expect(ipc.agentProcesses).toHaveBeenCalledTimes(2)
  })
})
