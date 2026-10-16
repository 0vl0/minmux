import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { AgentsList } from "./agents-list"
import { AgentsPanel } from "./agents-panel"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { reduceAgentEvents } from "../lib/agent-graph"
import type { PastSession, SearchEnd, SessionHit } from "../lib/past-sessions"
import type { ResumePlan } from "../lib/resume"
import { resetStore, testShell } from "../test/helpers"

const LIVE = "11111111-aaaa-bbbb-cccc-dddddddddddd"
const PAST = "22222222-aaaa-bbbb-cccc-dddddddddddd"
const GONE = "33333333-aaaa-bbbb-cccc-dddddddddddd"
const rows: PastSession[] = [
  { agent: "claude", sessionId: LIVE, name: "running one", cwd: "/w/term", updatedAt: Date.now() },
  {
    agent: "codex",
    sessionId: PAST,
    firstPrompt: "fix the quit drain",
    cwd: "/w/other",
    updatedAt: 1,
  },
  { agent: "claude", sessionId: GONE, name: "old", cwd: "/w/gone", updatedAt: 0, cwdGone: true },
]

describe("AgentsList", () => {
  beforeEach(() => {
    resetStore()
    localStorage.clear()
    vi.clearAllMocks()
    useStore.getState().newTab(testShell)
    const term = useStore.getState().tabs[0]!.activeSessionId
    useStore.setState({
      platform: "darwin",
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: LIVE, paneId: term, cwd: "/w/term" },
      ]),
    })
    vi.mocked(ipc.pastSessions).mockResolvedValue({ sessions: rows, failed: [] })
  })

  it("lists past sessions by name or first prompt, with their folder", async () => {
    render(<AgentsList />)
    expect(await screen.findByText("running one")).toBeInTheDocument()
    expect(screen.getByText("fix the quit drain")).toBeInTheDocument()
    expect(screen.getByText("/w/other")).toBeInTheDocument()
    expect(screen.getByText(/folder gone/)).toBeInTheDocument()
  })

  it("an open session: its agent's colour on the icon; others muted; a coloured one tinted", async () => {
    const term = useStore.getState().tabs[0]!.activeSessionId
    useStore.setState({ agentMeta: { [term]: { color: "blue" } } })
    vi.mocked(ipc.pastSessions).mockResolvedValue({
      sessions: [...rows.slice(0, 2), { ...rows[2]!, color: "red" }],
      failed: [],
    })
    const { container } = render(<AgentsList />)
    await screen.findByText("running one")
    const row = (text: string) => screen.getByText(text).closest(".past-session") as HTMLElement
    // The tint is on the session's whole box (its line and details).
    const box = (text: string) => screen.getByText(text).closest(".agent-line-box") as HTMLElement
    const open = row("running one")
    expect(open).toHaveClass("open")
    expect(open.querySelector(".agent-line-icon svg")!.getAttribute("style")).toMatch(/color/)
    expect(box("running one").style.getPropertyValue("--row-hue")).not.toBe("") // its pane's /color
    expect(box("running one")).toHaveClass("tinted")
    const past = row("fix the quit drain")
    expect(past).not.toHaveClass("open")
    expect(box("fix the quit drain")).not.toHaveClass("tinted") // no colour of its own
    expect(box("old")).toHaveClass("tinted") // its transcript's /color
    expect(container.querySelector(".dot")).toBeNull()
  })

  it("a running session: click goes to its pane, nothing is resumed", async () => {
    const focus = vi.fn()
    useStore.setState({ focusSession: focus })
    render(<AgentsList />)
    fireEvent.click(await screen.findByText("running one"))
    expect(focus).toHaveBeenCalledWith(useStore.getState().tabs[0]!.activeSessionId)
    expect(ipc.resumeOne).not.toHaveBeenCalled()
  })

  it("another session: asks main for its plan and resumes it in a split", async () => {
    const plan: ResumePlan = {
      status: "resume",
      agent: "codex",
      sessionId: PAST,
      cwd: "/w/other",
      command: `codex resume ${PAST}`,
    }
    vi.mocked(ipc.resumeOne).mockResolvedValue(plan)
    const resumeInSplit = vi.fn(() => "new-term")
    useStore.setState({ resumeInSplit })
    render(<AgentsList />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    expect(ipc.resumeOne).not.toHaveBeenCalled() // it asks first
    expect(screen.getByText("Opens in a split beside the pane you're in.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    await waitFor(() => expect(resumeInSplit).toHaveBeenCalledWith(plan))
    expect(ipc.resumeOne).toHaveBeenCalledWith({ agent: "codex", sessionId: PAST }, false)
  })

  it("Cancel, Esc, or a click outside: nothing is resumed", async () => {
    render(<AgentsList />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByText("fix the quit drain"))
    fireEvent.keyDown(window, { key: "Escape" })
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(ipc.resumeOne).not.toHaveBeenCalled()
  })

  it("says why when main won't resume it", async () => {
    vi.mocked(ipc.resumeOne).mockResolvedValue({
      status: "skip",
      sessionId: PAST,
      cwd: "/w/other",
      reason: "unrecognised session id",
    })
    render(<AgentsList />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    expect(await screen.findByText(/unrecognised session id/)).toBeInTheDocument()
  })

  it("a session whose folder is gone does nothing", async () => {
    render(<AgentsList />)
    fireEvent.click(await screen.findByText("old"))
    expect(ipc.resumeOne).not.toHaveBeenCalled()
  })

  it("an agent's chip hides its sessions, and stays off", async () => {
    const { unmount } = render(<AgentsList />)
    await screen.findByText("fix the quit drain")
    fireEvent.click(screen.getByTitle("Hide Codex sessions"))
    expect(screen.queryByText("fix the quit drain")).toBeNull()
    unmount()
    render(<AgentsList />)
    await screen.findByText("running one")
    expect(screen.queryByText("fix the quit drain")).toBeNull()
  })

  it("main says it may be running elsewhere: the dialog says so, Resume anyway resumes it", async () => {
    const plan: ResumePlan = {
      status: "resume",
      agent: "codex",
      sessionId: PAST,
      cwd: "/w/other",
      command: `codex resume ${PAST}`,
    }
    vi.mocked(ipc.resumeOne).mockImplementation(async (_s, confirmed) =>
      confirmed
        ? plan
        : {
            ...plan,
            status: "skip",
            busy: true,
            reason: "written 5s ago, may be running elsewhere",
          },
    )
    const resumeInSplit = vi.fn(() => "new-term")
    useStore.setState({ resumeInSplit })
    render(<AgentsList />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    expect(await screen.findByText(/may be running elsewhere/)).toBeInTheDocument()
    expect(resumeInSplit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Resume anyway" }))
    await waitFor(() => expect(resumeInSplit).toHaveBeenCalledWith(plan))
    expect(vi.mocked(ipc.resumeOne).mock.calls.map((c) => c[1])).toEqual([false, true])
  })

  it("every agent hidden: says so, not that there are none", async () => {
    localStorage.setItem("minmux.sessions.hidden", JSON.stringify(["claude", "codex", "opencode"]))
    render(<AgentsList />)
    expect(await screen.findByText("Every agent is hidden: turn one on above.")).toBeInTheDocument()
  })

  it("keys: Enter or Space on a row asks to resume it, Enter on its copy button doesn't", async () => {
    vi.mocked(ipc.resumeOne).mockResolvedValue(null)
    render(<AgentsList />)
    const row = (await screen.findByText("fix the quit drain")).closest(".past-session")!
    fireEvent.keyDown(row.querySelector(".past-session-id")!, { key: "Enter" })
    expect(ipc.resumeOne).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).toBeNull()
    fireEvent.keyDown(row, { key: " " })
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    await waitFor(() => expect(ipc.resumeOne).toHaveBeenCalledTimes(1))
  })

  it("says so when no terminal could be opened", async () => {
    vi.mocked(ipc.resumeOne).mockResolvedValue({
      status: "resume",
      sessionId: PAST,
      cwd: "/w/other",
      command: "codex resume x",
    })
    useStore.setState({ resumeInSplit: vi.fn(() => undefined) })
    render(<AgentsList />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    expect(await screen.findByText(/couldn't open a terminal/)).toBeInTheDocument()
  })

  it("the icon expands a row (▸ ▾) without going to its pane or resuming it", async () => {
    const focus = vi.fn()
    useStore.setState({ focusSession: focus })
    render(<AgentsList />)
    await screen.findByText("running one")
    const toggles = screen.getAllByLabelText("Show details")
    fireEvent.click(toggles[0]!)
    expect(focus).not.toHaveBeenCalled()
    expect(screen.getAllByLabelText("Hide details")).toHaveLength(1)
    expect(screen.getByLabelText("Hide details")).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(screen.getByLabelText("Hide details"))
    expect(screen.queryByLabelText("Hide details")).toBeNull()
  })

  it("a session that ended in a pane still open: in its group, dimmed; resumes beside that pane", async () => {
    const term = useStore.getState().tabs[0]!.activeSessionId
    useStore.setState({
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: PAST, paneId: term, cwd: "/w/other", agent: "codex" },
        { event: "SessionEnd", sessionId: PAST, paneId: term, agent: "codex" },
      ]),
    })
    const plan: ResumePlan = {
      status: "resume",
      agent: "codex",
      sessionId: PAST,
      cwd: "/w/other",
      command: `codex resume ${PAST}`,
    }
    vi.mocked(ipc.resumeOne).mockResolvedValue(plan)
    const order: string[] = []
    useStore.setState({
      agentMeta: { [term]: { name: "the-lead-now" } }, // the pane's current session's /rename
      focusSession: (id: string) => void order.push(`focus ${id}`),
      resumeInSplit: () => (order.push("split"), "new"),
    })
    render(<AgentsList />)
    const found = await screen.findByText("fix the quit drain")
    const line = found.closest(".agent-session")!
    expect(line).toHaveClass("ended")
    expect(line.textContent).toContain("ended")
    fireEvent.click(screen.getByText("fix the quit drain"))
    expect(screen.getByText("Opens in a split beside its pane.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    await waitFor(() => expect(order).toEqual([`focus ${term}`, "split"]))
  })

  it("the dialog keeps your focus through an update (an agent's hook event re-renders the list)", async () => {
    render(<AgentsList />)
    fireEvent.click(await screen.findByText("fix the quit drain"))
    const cancel = screen.getByRole("button", { name: "Cancel" })
    cancel.focus()
    act(() =>
      useStore.getState().applyAgentEvents([
        {
          event: "UserPromptSubmit",
          sessionId: LIVE,
          paneId: useStore.getState().tabs[0]!.activeSessionId,
        },
      ]),
    )
    expect(document.activeElement).toBe(cancel)
  })

  it("a running session outside a pane (elsewhere): a click asks nothing, resumes nothing", async () => {
    useStore.setState({
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: PAST, cwd: "/w/other", agent: "codex" },
      ]),
    })
    render(<AgentsList />)
    expect(await screen.findByText("Elsewhere")).toBeInTheDocument()
    fireEvent.click(screen.getByText("fix the quit drain"))
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(ipc.resumeOne).not.toHaveBeenCalled()
  })

  it("a running session's live /rename names its row", async () => {
    const term = useStore.getState().tabs[0]!.activeSessionId
    useStore.setState({ agentMeta: { [term]: { name: "auth-fix" } } })
    render(<AgentsList />)
    expect(await screen.findByText("auth-fix")).toBeInTheDocument()
    expect(screen.queryByText("running one")).toBeNull()
  })

  it("expanded: what it is (agent, branch and PR as the sidebar shows them, id, full folder)", async () => {
    const term = useStore.getState().tabs[0]!.activeSessionId
    useStore.setState({
      paneGit: {
        [term]: { branch: "feat/x", pr: { number: 42, state: "merged", url: "https://gh/pr/42" } },
      },
    })
    render(<AgentsList />)
    await screen.findByText("running one")
    fireEvent.click(screen.getAllByLabelText("Show details")[0]!)
    const info = document.querySelector(".agent-line-info")!
    expect(info.textContent).toContain("Claude")
    expect(info.textContent).toContain("feat/x")
    expect(info.textContent).toContain("PR #42")
    expect(info.textContent).toContain("merged") // its state, as in the sidebar
    expect(info.textContent).toContain(LIVE.slice(0, 8))
    expect(info.textContent).toContain("/w/term")
    expect(
      screen.getByTitle("https://gh/pr/42: show it in the pull requests dialog"),
    ).toBeInTheDocument()
  })

  it("the agent's own checkout when it moved (a worktree), else its pane's; none for a session that ended there", async () => {
    const term = useStore.getState().tabs[0]!.activeSessionId
    useStore.setState({
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: PAST, paneId: term, cwd: "/w/old", agent: "codex" },
        { event: "SessionEnd", sessionId: PAST, paneId: term, agent: "codex" },
        {
          event: "SessionStart",
          sessionId: LIVE,
          paneId: term,
          cwd: "/w/term/.claude/worktrees/a",
        },
      ]),
      sessions: {
        ...useStore.getState().sessions,
        [term]: { ...useStore.getState().sessions[term]!, cwd: "/w/term" },
      },
      paneGit: {
        [term]: { branch: "main" },
        [`${term}@in`]: { branch: "wt-a", forCwd: "/w/term/.claude/worktrees/a" },
      },
    })
    render(<AgentsList />)
    await screen.findByText("running one")
    screen.getAllByLabelText("Show details").forEach((b) => fireEvent.click(b))
    const infos = [...document.querySelectorAll(".agent-line-info")].map((e) => e.textContent ?? "")
    expect(infos.find((t) => t.startsWith("Claude"))).toContain("wt-a")
    expect(infos.find((t) => t.startsWith("Claude"))).not.toContain("main")
    expect(infos.find((t) => t.startsWith("Codex"))).not.toContain("wt-a") // ended: not the lead
    expect(infos.find((t) => t.startsWith("Codex"))).not.toContain("main")
  })

  it("expanded inactive: agent and folder, then its first prompt; the id once", async () => {
    render(<AgentsList />)
    const line = (await screen.findByText("fix the quit drain")).closest(".agent-line-box")!
    fireEvent.click(line.querySelector('[aria-label="Show details"]')!)
    expect(line.querySelector(".agent-line-info")?.textContent).toContain("Codex")
    expect(line.querySelector(".agent-line-info")?.textContent).toContain("/w/other")
    // Its id is on the line already (one copy button, not two).
    expect(line.querySelectorAll(".past-session-id")).toHaveLength(1)
  })

  it("Inactive draws its newest 100 rows, the rest on Show more", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      agent: "codex" as const,
      sessionId: `s-${i}`,
      name: `old session ${i}`,
      cwd: "/w/x",
      updatedAt: 1000 - i,
    }))
    vi.mocked(ipc.pastSessions).mockResolvedValue({ sessions: many, failed: [] })
    render(<AgentsList />)
    await screen.findByText("old session 0")
    const inactiveRows = () => document.querySelectorAll(".agents-inactive .agent-line").length
    expect(inactiveRows()).toBe(100)
    fireEvent.click(screen.getByRole("button", { name: "Show 50 more of 50" }))
    expect(inactiveRows()).toBe(150)
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull()
    // A filter change starts over at the newest 100.
    fireEvent.click(screen.getByTitle("Hide Claude sessions"))
    await waitFor(() => expect(inactiveRows()).toBe(100))
  })

  it("names the agents whose sessions couldn't be read", async () => {
    vi.mocked(ipc.pastSessions).mockResolvedValue({ sessions: [], failed: ["codex"] })
    render(<AgentsList />)
    expect(await screen.findByText("Couldn't read Codex sessions.")).toBeInTheDocument()
  })
})

describe("AgentsList search", () => {
  let deliver: (id: number, hits: SessionHit[], end: SearchEnd | null) => void
  beforeEach(() => {
    resetStore()
    localStorage.clear()
    vi.clearAllMocks()
    useStore.getState().newTab(testShell)
    useStore.setState({ platform: "darwin" })
    vi.mocked(ipc.pastSessions).mockResolvedValue({ sessions: rows, failed: [] })
    vi.mocked(ipc.searchSessions).mockResolvedValue(7)
    vi.mocked(ipc.onSessionHits).mockImplementation((cb) => {
      deliver = cb
      return () => {}
    })
  })
  const hit: SessionHit = {
    agent: "codex",
    sessionId: PAST,
    snippet: "…we fixed the quit drain today",
    match: 14,
    length: 10,
  }

  it("shows only the sessions found, with the words marked in context", async () => {
    render(<AgentsList />)
    await screen.findByText("running one")
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "quit drain" },
    })
    await waitFor(() =>
      expect(ipc.searchSessions).toHaveBeenCalledWith(
        "quit drain",
        ["claude", "codex", "opencode"],
        undefined,
      ),
    )
    expect(await screen.findByText("Searching…")).toBeInTheDocument()
    act(() => deliver(7, [hit], null))
    expect(screen.getByText("quit drain", { selector: "mark" })).toBeInTheDocument()
    expect(screen.queryByText("running one")).toBeNull() // not a hit: not shown
    act(() => deliver(7, [], { capped: false }))
    expect(screen.getByText("1 session")).toBeInTheDocument()
  })

  it("ignores another search's hits, says when nothing matched, Esc clears it", async () => {
    render(<AgentsList />)
    await screen.findByText("running one")
    const box = screen.getByLabelText("Search conversations")
    fireEvent.change(box, { target: { value: "nothing here" } })
    await waitFor(() => expect(ipc.searchSessions).toHaveBeenCalled())
    await waitFor(() => act(() => deliver(6, [hit], { capped: false }))) // an older search's
    act(() => deliver(7, [], { capped: false }))
    expect(await screen.findByText("No conversation has those words.")).toBeInTheDocument()
    fireEvent.keyDown(box, { key: "Escape" })
    expect(await screen.findByText("running one")).toBeInTheDocument()
    expect(ipc.cancelSessionSearch).toHaveBeenCalledWith(7)
  })

  it("says when the search stopped early, or failed", async () => {
    render(<AgentsList />)
    await screen.findByText("running one")
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "quit" } })
    await waitFor(() => expect(ipc.searchSessions).toHaveBeenCalled())
    await waitFor(() => act(() => deliver(7, [hit], { capped: false, timedOut: true })))
    expect(
      screen.getByText("1 session in the time allowed: the search stopped early."),
    ).toBeInTheDocument()
    act(() => deliver(7, [], { capped: false, couldNot: ["opencode"] }))
    expect(screen.getByText("1 session. Couldn't search OpenCode sessions.")).toBeInTheDocument()
    act(() => deliver(7, [], { capped: false, couldNot: ["codex", "opencode"] }))
    expect(
      screen.getByText("1 session. Couldn't search Codex and OpenCode sessions."),
    ).toBeInTheDocument()
    act(() => deliver(7, [], { capped: false, failed: true }))
    expect(screen.getByText("The search failed. Try again.")).toBeInTheDocument()
  })

  it("a search that answers after the query changed is cancelled, never shown", async () => {
    let answer!: (id: number) => void
    vi.mocked(ipc.searchSessions).mockImplementationOnce(() => new Promise((r) => (answer = r)))
    render(<AgentsList />)
    await screen.findByText("running one")
    const box = screen.getByLabelText("Search conversations")
    fireEvent.change(box, { target: { value: "quit" } })
    await waitFor(() => expect(ipc.searchSessions).toHaveBeenCalledTimes(1))
    fireEvent.change(box, { target: { value: "" } }) // cleared before it answered
    await act(async () => answer(5))
    expect(ipc.cancelSessionSearch).toHaveBeenCalledWith(5)
    act(() => deliver(5, [hit], null))
    expect(screen.queryByText("quit drain", { selector: "mark" })).toBeNull()
  })

  it("shows a hit the list doesn't have yet, from its own row", async () => {
    render(<AgentsList />)
    await screen.findByText("running one")
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "brand" } })
    await waitFor(() => expect(ipc.searchSessions).toHaveBeenCalled())
    const NEW = "55555555-aaaa-bbbb-cccc-dddddddddddd"
    const fresh: SessionHit = {
      agent: "claude",
      sessionId: NEW,
      snippet: "a brand new one",
      match: 2,
      length: 5,
      session: {
        agent: "claude",
        sessionId: NEW,
        name: "started after the list",
        cwd: "/w/n",
        updatedAt: Date.now(),
      },
    }
    await waitFor(() => act(() => deliver(7, [fresh], { capped: false })))
    expect(await screen.findByText("started after the list")).toBeInTheDocument()
  })

  it("searches the trimmed words, within the folder when 'This folder' is on", async () => {
    useStore.setState((st) => ({
      sessions: Object.fromEntries(
        Object.entries(st.sessions).map(([k, v]) => [k, { ...v, cwd: "/w/other" }]),
      ),
    }))
    localStorage.setItem("minmux.sessions.here", "1")
    render(<AgentsList />)
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "  quit  " },
    })
    await waitFor(() =>
      expect(ipc.searchSessions).toHaveBeenCalledWith(
        "quit",
        ["claude", "codex", "opencode"],
        "/w/other",
      ),
    )
  })

  it("a search that fails to start says so", async () => {
    vi.mocked(ipc.searchSessions).mockRejectedValueOnce(new Error("no worker"))
    render(<AgentsList />)
    await screen.findByText("running one")
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "quit" } })
    expect(await screen.findByText("The search failed. Try again.")).toBeInTheDocument()
  })

  it("one character doesn't search", async () => {
    render(<AgentsList />)
    await screen.findByText("running one")
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "q" } })
    await new Promise((r) => setTimeout(r, 400))
    expect(ipc.searchSessions).not.toHaveBeenCalled()
  })
})

describe("AgentsPanel: one list", () => {
  beforeEach(() => {
    resetStore()
    localStorage.clear()
    vi.clearAllMocks()
  })

  it("no tabs: the sessions in open panes, grouped like the sidebar, current group first; then Inactive", async () => {
    useStore.getState().newTab(testShell)
    const t1 = useStore.getState().tabs[0]!
    useStore.getState().newTab(testShell) // the current one now
    const t2 = useStore.getState().tabs[1]!
    useStore.getState().renameTab(t2.id, "api")
    useStore.setState({
      platform: "darwin",
      agents: reduceAgentEvents([
        { event: "SessionStart", sessionId: LIVE, paneId: t1.activeSessionId, cwd: "/w/term" },
        { event: "SessionStart", sessionId: PAST, paneId: t2.activeSessionId, cwd: "/w/other" },
      ]),
    })
    vi.mocked(ipc.pastSessions).mockResolvedValue({ sessions: [rows[2]!], failed: [] })
    render(<AgentsPanel />)
    expect(screen.queryByRole("tab")).toBeNull()
    await screen.findByText("old")
    const names = [...document.querySelectorAll(".agents-group-name")].map((e) => e.textContent)
    expect(names).toEqual(["api", expect.any(String), "Inactive"]) // the current group first
    expect(names[1]).not.toBe("api")
    // The pane you're in: its session has the Live tab's border.
    const active = document.querySelectorAll(".agent-session.active")
    expect(active).toHaveLength(1)
    expect(
      active[0]!.closest(".agents-group")?.querySelector(".agents-group-name")?.textContent,
    ).toBe("api")
  })
})
