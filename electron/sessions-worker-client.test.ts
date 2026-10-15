import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SessionHit } from "../src/lib/past-sessions"
import type { ListedSession } from "./agents/types"
import { SessionsOps, type SessionsReply, type SessionsRequest } from "./sessions-ops"
import { parsePs } from "./proc-snapshot"
import { SessionsWorkerClient, type SessionsProc } from "./sessions-worker-client"

const listed = (o: Partial<ListedSession>): ListedSession => ({
  agent: "claude",
  sessionId: "a",
  updatedAt: 1,
  ...o,
})

describe("SessionsOps", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-"))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const ops = (rows: ListedSession[]) => {
    const replies: SessionsReply[] = []
    const o = new SessionsOps(
      {
        claude: {
          history: { list: async () => rows },
          texts: (line) => (typeof line.text === "string" ? [line.text] : []),
          quick: () => true,
        },
      },
      (r) => replies.push(r),
    )
    const settled = async (id: number) => {
      await vi.waitFor(() => expect(replies.some((r) => r.id === id && "ok" in r)).toBe(true))
      return replies.filter((r) => r.id === id)
    }
    return { o, replies, settled }
  }

  it("lists an agent's sessions; an unknown agent has none", async () => {
    const { o, settled } = ops([listed({})])
    o.handle({ id: 1, op: "list", agent: "claude" })
    o.handle({ id: 2, op: "list", agent: "codex" })
    expect(await settled(1)).toEqual([{ id: 1, ok: true, value: [listed({})] }])
    expect(await settled(2)).toEqual([{ id: 2, ok: true, value: [] }])
  })

  it("searches only the sessions in the folder asked for", async () => {
    const a = path.join(dir, "a.jsonl")
    const b = path.join(dir, "b.jsonl")
    for (const f of [a, b]) fs.writeFileSync(f, JSON.stringify({ text: "quit" }) + "\n")
    const { o, replies, settled } = ops([
      listed({ sessionId: "in", cwd: "/w/term/sub", transcriptPath: a }),
      listed({ sessionId: "out", cwd: "/w/other", transcriptPath: b }),
    ])
    o.handle({ id: 4, op: "search", query: "quit", agents: ["claude"], rg: null, under: "/w/term" })
    await settled(4)
    expect(replies.flatMap((r) => ("hit" in r ? [r.hit.sessionId] : []))).toEqual(["in"])
  })

  it("shares a listing while it runs; a search reuses a recent one", async () => {
    let reads = 0
    const replies: SessionsReply[] = []
    const o = new SessionsOps(
      {
        claude: {
          history: {
            list: async () => {
              reads++
              await new Promise((r) => setTimeout(r, 10))
              return []
            },
          },
          texts: () => [],
          quick: () => true,
        },
      },
      (r) => replies.push(r),
    )
    o.handle({ id: 1, op: "list", agent: "claude" })
    o.handle({ id: 2, op: "list", agent: "claude" })
    await vi.waitFor(() => expect(replies.filter((r) => "ok" in r)).toHaveLength(2))
    expect(reads).toBe(1)
    o.handle({ id: 3, op: "search", query: "quit", agents: ["claude"], rg: null })
    await vi.waitFor(() => expect(replies.filter((r) => "ok" in r)).toHaveLength(3))
    expect(reads).toBe(1) // reused
  })

  it("a store's sessions are searched in the same newest-first pass; touched asks it", async () => {
    const f = path.join(dir, "a.jsonl")
    fs.writeFileSync(f, JSON.stringify({ text: "quit" }) + "\n")
    const replies: SessionsReply[] = []
    const checked: string[] = []
    const closed = vi.fn()
    const own = {
      searcher: vi.fn(() => ({
        check: (id: string): SessionHit => {
          checked.push(id)
          return { agent: "opencode", sessionId: id, snippet: "quit", match: 0, length: 4 }
        },
        close: closed,
      })),
      touched: vi.fn(async () => 99),
    }
    const o = new SessionsOps(
      {
        claude: {
          history: { list: async () => [listed({ transcriptPath: f, updatedAt: 3 })] },
          texts: (line) => (typeof line.text === "string" ? [line.text] : []),
          quick: () => true,
        },
        opencode: {
          history: {
            list: async () => [
              listed({ agent: "opencode", sessionId: "ses_new", updatedAt: 5 }),
              listed({ agent: "opencode", sessionId: "ses_old", updatedAt: 1 }),
            ],
          },
          own,
        },
      },
      (r) => replies.push(r),
    )
    o.handle({ id: 5, op: "search", query: "quit", agents: ["claude", "opencode"], rg: null })
    await vi.waitFor(() => expect(replies.some((r) => r.id === 5 && "ok" in r)).toBe(true))
    expect(replies.flatMap((r) => ("hit" in r ? [r.hit.sessionId] : []))).toEqual([
      "ses_new",
      "a",
      "ses_old",
    ])
    expect(closed).toHaveBeenCalled()
    o.handle({ id: 6, op: "touched", agent: "opencode", sessionId: "ses_new" })
    o.handle({ id: 7, op: "touched", agent: "claude", sessionId: "a" })
    await vi.waitFor(() =>
      expect(replies.filter((r) => (r.id === 6 || r.id === 7) && "ok" in r)).toHaveLength(2),
    )
    expect(replies.find((r) => r.id === 6)).toEqual({ id: 6, ok: true, value: 99 })
    expect(replies.find((r) => r.id === 7)).toEqual({ id: 7, ok: true, value: null })
  })

  it("a store whose listing fails during a search is named too", async () => {
    const replies: SessionsReply[] = []
    const o = new SessionsOps(
      {
        opencode: {
          history: { list: () => Promise.reject(new Error("database is locked")) },
          own: { searcher: () => null, touched: async () => undefined },
        },
      },
      (r) => replies.push(r),
    )
    o.handle({ id: 9, op: "search", query: "quit", agents: ["opencode"], rg: null })
    await vi.waitFor(() => expect(replies.some((r) => r.id === 9 && "ok" in r)).toBe(true))
    expect(replies.find((r) => r.id === 9 && "ok" in r)).toMatchObject({
      value: { couldNot: ["opencode"] },
    })
  })

  it("a store that can't be searched is named, not read as no matches", async () => {
    const replies: SessionsReply[] = []
    const o = new SessionsOps(
      {
        opencode: {
          history: { list: async () => [listed({ agent: "opencode", sessionId: "ses_x" })] },
          own: {
            searcher: () => {
              throw new Error("no such table: part")
            },
            touched: async () => undefined,
          },
        },
      },
      (r) => replies.push(r),
    )
    o.handle({ id: 8, op: "search", query: "quit", agents: ["opencode"], rg: null })
    await vi.waitFor(() => expect(replies.some((r) => r.id === 8 && "ok" in r)).toBe(true))
    expect(replies.find((r) => r.id === 8 && "ok" in r)).toEqual({
      id: 8,
      ok: true,
      value: { capped: false, couldNot: ["opencode"] },
    })
  })

  it("searches the listed transcripts, posting each hit, then done", async () => {
    const f = path.join(dir, "a.jsonl")
    fs.writeFileSync(f, JSON.stringify({ text: "the quit drain" }) + "\n")
    const { o, settled } = ops([listed({ transcriptPath: f })])
    o.handle({ id: 3, op: "search", query: "QUIT", agents: ["claude"], rg: null })
    const out = await settled(3)
    expect(out[0]).toMatchObject({ id: 3, hit: { agent: "claude", sessionId: "a" } })
    // Its row comes with it (main records it for a resume, and strips the path).
    expect((out[0] as { hit: { session: object } }).hit.session).toEqual(
      listed({ transcriptPath: f }),
    )
    expect(out[1]).toEqual({ id: 3, ok: true, value: { capped: false } })
  })
})

describe("SessionsOps: agent processes", () => {
  const ps = [
    "  100     1 501   0.0  2048 Thu Oct  1 19:02:17 2026     /bin/zsh",
    "  110   100 501  20.0  2048 Thu Oct  1 19:02:17 2026     claude",
    "  120   110 501   0.0  2048 Thu Oct  1 19:02:18 2026     npm test",
    "  121   120 501  50.0  2048 Thu Oct  1 19:02:19 2026     node vitest",
  ].join("\n")
  const pane = { paneId: "p", shellPid: 100 }
  const agentNames = ["claude"]
  const setup = () => {
    const replies: SessionsReply[] = []
    let scans = 0
    const o = new SessionsOps(
      {},
      (r) => replies.push(r),
      async () => {
        scans++
        await new Promise((r) => setTimeout(r, 5))
        return { snap: parsePs(ps), markers: new Map() }
      },
      async (pids) => new Map(pids.includes(121) ? [[121, [5173]]] : []),
    )
    const value = async (id: number) => {
      await vi.waitFor(() => expect(replies.some((r) => r.id === id && "ok" in r)).toBe(true))
      return (replies.find((r) => r.id === id && "ok" in r) as { value: unknown }).value
    }
    return { o, value, scans: () => scans }
  }

  it("attributes one snapshot; polls asked for while it runs share it", async () => {
    const { o, value, scans } = setup()
    o.handle({ id: 1, op: "procs", panes: [pane], open: ["p"], owned: ["p"], uid: 501, agentNames })
    o.handle({ id: 2, op: "procs", panes: [pane], open: ["p"], owned: ["p"], uid: 501, agentNames })
    const a = (await value(1)) as { panes: Record<string, { pid: number; ports?: number[] }[]> }
    expect(a.panes.p!.map((r) => r.pid)).toEqual([120, 121])
    expect(a.panes.p![1]!.ports).toEqual([5173]) // listening ports, from lsof
    await value(2)
    expect(scans()).toBe(1)
  })

  it("ports: a lookup is kept a while, a failed one as none (a broken lsof isn't run each poll)", async () => {
    const replies: SessionsReply[] = []
    let lookups = 0
    const o = new SessionsOps(
      {},
      (r) => replies.push(r),
      async () => ({ snap: parsePs(ps), markers: new Map() }),
      async () => {
        if (++lookups === 1) throw new Error("lsof killed")
        return new Map([[121, [5173]]])
      },
    )
    const ask = async (id: number) => {
      o.handle({ id, op: "procs", panes: [pane], open: ["p"], owned: ["p"], uid: 501, agentNames })
      await vi.waitFor(() => expect(replies.some((r) => r.id === id && "ok" in r)).toBe(true))
      const r = replies.find((r) => r.id === id && "ok" in r) as {
        value: { panes: Record<string, { ports?: number[] }[]> }
      }
      return r.value.panes.p![1]!.ports
    }
    expect(await ask(1)).toBeUndefined() // failed: no ports, the list still answers
    expect(await ask(2)).toBeUndefined()
    expect(lookups).toBe(1)
    vi.useFakeTimers({ now: Date.now() + 11_000, toFake: ["Date"] })
    try {
      expect(await ask(3)).toEqual([5173]) // PORTS_MS later: asked again
      expect(await ask(4)).toEqual([5173])
      expect(lookups).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("kill order: the process and its children, deepest first, only if it's still the same one", async () => {
    const { o, value } = setup()
    const started = Date.parse("Thu Oct 1 19:02:18 2026")
    o.handle({
      id: 3,
      op: "kill-order",
      paneId: "p",
      panes: [pane],
      owned: ["p"],
      pid: 120,
      started,
      uid: 501,
      agentNames,
    })
    expect(((await value(3)) as { pid: number }[]).map((p) => p.pid)).toEqual([121, 120])
    // Another start: a reused pid, never signalled.
    o.handle({
      id: 4,
      op: "kill-order",
      paneId: "p",
      panes: [pane],
      owned: ["p"],
      pid: 120,
      started: started + 60_000,
      uid: 501,
      agentNames,
    })
    expect(await value(4)).toEqual([])
    // Not the agent's (the shell itself): none.
    o.handle({
      id: 5,
      op: "kill-order",
      paneId: "p",
      panes: [pane],
      owned: ["p"],
      pid: 100,
      started,
      uid: 501,
      agentNames,
    })
    expect(await value(5)).toEqual([])
  })

  it("kill order: none for a process with an agent under it (a bash running codex)", async () => {
    const replies: SessionsReply[] = []
    const o = new SessionsOps(
      {},
      (r) => replies.push(r),
      async () => ({
        snap: parsePs(
          [ps, "  130   120 501   0.0  2048 Thu Oct  1 19:02:19 2026     codex exec"].join("\n"),
        ),
        markers: new Map(),
      }),
    )
    o.handle({
      id: 1,
      op: "kill-order",
      paneId: "p",
      panes: [pane],
      owned: ["p"],
      pid: 120,
      started: Date.parse("Thu Oct 1 19:02:18 2026"),
      uid: 501,
      agentNames: ["claude", "codex"],
    })
    await vi.waitFor(() => expect(replies.some((r) => r.id === 1 && "ok" in r)).toBe(true))
    expect((replies.find((r) => r.id === 1 && "ok" in r) as { value: unknown }).value).toEqual([])
  })

  it("no scan available: the request fails (the list says it couldn't read)", async () => {
    const replies: SessionsReply[] = []
    const o = new SessionsOps({}, (r) => replies.push(r))
    o.handle({ id: 6, op: "procs", panes: [pane], open: ["p"], owned: ["p"], uid: 501, agentNames })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toMatchObject({ id: 6, ok: false })
  })
})

// A fake worker process: what main posts, and a way to answer as the worker would.
function fakeProc() {
  const sent: SessionsRequest[] = []
  let onMsg: (m: SessionsReply) => void = () => {}
  let onExit: (c: number) => void = () => {}
  const proc: SessionsProc & { killed: boolean } = {
    killed: false,
    postMessage: (m) => sent.push(m),
    on: ((ev: string, fn: never) => {
      if (ev === "message") onMsg = fn
      else onExit = fn
    }) as SessionsProc["on"],
    kill: () => (proc.killed = true),
  }
  return { proc, sent, reply: (m: SessionsReply) => onMsg(m), exit: () => onExit(1) }
}

describe("SessionsWorkerClient", () => {
  afterEach(() => vi.useRealTimers())

  it("starts the worker on first use and answers by request id", async () => {
    const w = fakeProc()
    const fork = vi.fn(() => w.proc)
    const c = new SessionsWorkerClient(fork)
    expect(fork).not.toHaveBeenCalled()
    const p = c.list("claude")
    expect(w.sent).toEqual([{ id: 1, op: "list", agent: "claude" }])
    w.reply({ id: 1, ok: true, value: [listed({})] })
    expect(await p).toEqual([listed({})])
    c.dispose()
  })

  it("streams a search's hits, then its end; cancel tells the worker", async () => {
    const w = fakeProc()
    const c = new SessionsWorkerClient(() => w.proc)
    const hits: SessionHit[] = []
    const s = c.search("quit", ["claude"], "/bin/rg", undefined, (h) => hits.push(h))
    const hit: SessionHit = {
      agent: "claude",
      sessionId: "a",
      snippet: "quit",
      match: 0,
      length: 4,
    }
    w.reply({ id: 1, hit })
    s.cancel()
    expect(w.sent[1]).toEqual({ id: 1, op: "cancel" })
    w.reply({ id: 1, ok: true, value: { capped: false } })
    expect(await s.done).toEqual({ capped: false })
    expect(hits).toEqual([hit])
    c.dispose()
  })

  it("a stuck worker is killed, what it held fails, and the next call starts a new one", async () => {
    vi.useFakeTimers()
    const first = fakeProc()
    const second = fakeProc()
    const fork = vi.fn().mockReturnValueOnce(first.proc).mockReturnValueOnce(second.proc)
    const c = new SessionsWorkerClient(fork, { listMs: 100 })
    const p = c.list("claude")
    const failed = expect(p).rejects.toMatchObject({ code: "EHUNG" })
    await vi.advanceTimersByTimeAsync(150)
    await failed
    expect(first.proc.killed).toBe(true)
    const next = c.list("codex")
    second.reply({ id: 2, ok: true, value: [] })
    expect(await next).toEqual([])
    c.dispose()
  })

  it("a worker that exits fails what it held; an error reply rejects with its code", async () => {
    const w = fakeProc()
    const c = new SessionsWorkerClient(() => w.proc)
    const a = c.list("claude")
    const b = c.list("codex")
    w.reply({ id: 2, ok: false, code: "EACCES" })
    await expect(b).rejects.toMatchObject({ code: "EACCES" })
    w.exit()
    await expect(a).rejects.toMatchObject({ code: "EGONE" })
  })

  it("a late touched fails only itself: a worker busy listing isn't stopped", async () => {
    vi.useFakeTimers()
    const w = fakeProc()
    const c = new SessionsWorkerClient(() => w.proc)
    const list = c.list("claude")
    const t = c.touched("opencode", "ses_x")
    const late = expect(t).rejects.toMatchObject({ code: "ELATE" })
    await vi.advanceTimersByTimeAsync(6000)
    await late
    expect(w.proc.killed).toBe(false)
    w.reply({ id: 1, ok: true, value: [] })
    expect(await list).toEqual([])
    c.dispose()
  })

  it("a worker that doesn't exit when stopped is force-killed", async () => {
    vi.useFakeTimers()
    const w = fakeProc()
    Object.assign(w.proc, { pid: 424242 })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const c = new SessionsWorkerClient(() => w.proc)
    void c.list("claude").catch(() => {})
    c.dispose()
    await vi.advanceTimersByTimeAsync(2500)
    expect(kill).toHaveBeenCalledWith(424242, "SIGKILL")
    kill.mockRestore()
  })

  it("…but not one that exited", async () => {
    vi.useFakeTimers()
    const w = fakeProc()
    Object.assign(w.proc, { pid: 424243 })
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true)
    const c = new SessionsWorkerClient(() => w.proc)
    void c.list("claude").catch(() => {})
    c.dispose()
    w.exit()
    await vi.advanceTimersByTimeAsync(2500)
    expect(kill).not.toHaveBeenCalled()
    kill.mockRestore()
  })

  it("an idle worker is shut down, after any number of requests", async () => {
    vi.useFakeTimers()
    const w = fakeProc()
    const c = new SessionsWorkerClient(() => w.proc, { idleMs: 1000 })
    for (const id of [1, 2, 3]) {
      const p = c.list("claude")
      w.reply({ id, ok: true, value: [] })
      await p
    }
    await vi.advanceTimersByTimeAsync(1500)
    expect(w.proc.killed).toBe(true)
  })
})
