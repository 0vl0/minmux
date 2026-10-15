// The sessions worker's requests (sessions-worker.ts): list one agent's past sessions, search
// their conversations. Pure of Electron, so tests drive it directly.

import type { AgentKind } from "../src/lib/agent-graph"
import { filterPast, type SessionHit } from "../src/lib/past-sessions"
import type { ListedSession, SessionChecker } from "./agents/types"
import type { AgentHistory } from "./agents/history-index"
import { searchFiles, type SearchFile } from "./session-search"
import type { AgentProc } from "../src/lib/agent-processes"
import { attribute, killOrder, type Marker, type PaneRoots, type Snapshot } from "./proc-snapshot"

export type SessionsRequest =
  | { id: number; op: "list"; agent: AgentKind }
  | {
      id: number
      op: "search"
      query: string
      agents: AgentKind[]
      rg: string | null
      under?: string // only sessions in this folder or below
    }
  | { id: number; op: "cancel" }
  | { id: number; op: "touched"; agent: AgentKind; sessionId: string }
  | { id: number; op: "procs"; panes: PaneRoots[]; uid: number; agentNames: string[] }
  | {
      id: number
      op: "kill-order"
      paneId: string
      pane: PaneRoots
      pid: number
      started: number
      uid: number
      agentNames: string[]
    }

export interface SearchDone {
  capped: boolean // stopped at the most sessions it shows
  timedOut?: boolean
  couldNot?: AgentKind[] // agents whose store couldn't be searched
}

export type SessionsReply =
  | {
      id: number
      ok: true
      value:
        | ListedSession[]
        | SearchDone
        | number
        | null
        | Record<string, AgentProc[]>
        | { pid: number; started: number }[]
    }
  | { id: number; ok: false; code: string }
  | { id: number; hit: SessionHit }

/** Every process, and the pane each one's environment names (proc-scan.ts). */
export type Scan = { snap: Snapshot; markers: Map<number, Marker> }

export const SEARCH_MS = 20_000
const REUSE_MS = 5_000 // a search reuses a listing this recent

export class SessionsOps {
  private searches = new Map<number, AbortController>()

  constructor(
    private readonly agents: Partial<Record<AgentKind, AgentHistory>>,
    private readonly post: (reply: SessionsReply) => void,
    private readonly scan: () => Promise<Scan> = () => Promise.reject(new Error("no process scan")),
  ) {}

  handle(req: SessionsRequest): void {
    if (req.op === "cancel") return this.searches.get(req.id)?.abort()
    const run = ((): Promise<Extract<SessionsReply, { ok: true }>["value"]> => {
      switch (req.op) {
        case "list":
          return this.list(req.agent)
        case "touched":
          return this.touched(req.agent, req.sessionId)
        case "procs":
          return this.procs(req.panes, req.uid, new Set(req.agentNames))
        case "kill-order":
          return this.killOrder(req)
        case "search":
          return this.search(req)
      }
    })()
    void run.then(
      (value) => this.post({ id: req.id, ok: true, value }),
      (e: unknown) =>
        this.post({ id: req.id, ok: false, code: String((e as Error)?.message ?? e) }),
    )
  }

  // A listing is shared while it runs, and a search reuses one this recent: typing doesn't walk
  // every transcript folder once per keystroke.
  private listed = new Map<AgentKind, { at: number; rows: Promise<ListedSession[]> }>()

  private list(agent: AgentKind, maxAgeMs = 0): Promise<ListedSession[]> {
    const had = this.listed.get(agent)
    if (had && (had.at === 0 || Date.now() - had.at <= maxAgeMs)) return had.rows
    const entry = { at: 0, rows: Promise.resolve([] as ListedSession[]) }
    entry.rows = (this.agents[agent]?.history.list() ?? Promise.resolve([])).then(
      (rows) => {
        entry.at = Date.now()
        return rows
      },
      (e: unknown) => {
        this.listed.delete(agent)
        throw e
      },
    )
    this.listed.set(agent, entry)
    return entry.rows
  }

  // One snapshot at a time: a poll asked for while one runs shares it (never stacked).
  private snapshot: Promise<Scan> | null = null

  /** Per pane: the processes its agents run (docs/design/AGENT_PROCESSES.md). */
  private async procs(
    panes: PaneRoots[],
    uid: number,
    agentNames: ReadonlySet<string>,
  ): Promise<Record<string, AgentProc[]>> {
    const { snap, markers } = await this.fresh()
    return attribute(snap, markers, panes, uid, agentNames)
  }

  /** The pids to signal to end `pid` and its children (deepest first), checked against a fresh
   *  snapshot: still the same process (its start), still this pane's agent's. Else none. */
  private async killOrder(
    req: Extract<SessionsRequest, { op: "kill-order" }>,
  ): Promise<{ pid: number; started: number }[]> {
    // Its own snapshot, taken now: one a poll started before the click could show a pid since
    // reused by another process.
    const { snap, markers } = await this.scan()
    const rows =
      attribute(snap, markers, [req.pane], req.uid, new Set(req.agentNames))[req.paneId] ?? []
    const row = rows.find((r) => r.pid === req.pid)
    if (!row || Math.abs(row.started - req.started) > 1000) return []
    // Only the user's own (the kernel would refuse the rest anyway).
    return killOrder(snap, req.pid).filter((p) => snap.get(p.pid)?.uid === req.uid)
  }

  private fresh() {
    this.snapshot ??= this.scan().finally(() => (this.snapshot = null))
    return this.snapshot
  }

  /** When a session was last written, from its agent's own store (null: it can't say). */
  private async touched(agent: AgentKind, sessionId: string): Promise<number | null> {
    return (await this.agents[agent]?.own?.touched(sessionId)) ?? null
  }

  private async search(req: Extract<SessionsRequest, { op: "search" }>): Promise<SearchDone> {
    const ctl = new AbortController()
    this.searches.set(req.id, ctl)
    let timer: ReturnType<typeof setTimeout> | undefined
    const checkers = new Map<AgentKind, SessionChecker>()
    let timedOut = false
    try {
      // The listed sessions (cached reads), newest first across agents.
      // An agent whose store can't even be listed can't be searched: named, never "no matches".
      const failed = new Set<AgentKind>()
      const lists = await Promise.all(
        req.agents.map((a) =>
          this.list(a, REUSE_MS).catch(() => {
            if (this.agents[a]?.own) failed.add(a)
            return [] as ListedSession[]
          }),
        ),
      )
      const rows = filterPast(lists.flat(), new Set(req.agents), req.under).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )
      const byKey = new Map(rows.map((s) => [`${s.agent}:${s.sessionId}`, s]))
      // Newest first across agents: a transcript file, or (no file) the agent's own store.
      const files: SearchFile[] = rows.flatMap((s) =>
        s.transcriptPath
          ? [{ agent: s.agent, sessionId: s.sessionId, file: s.transcriptPath }]
          : this.agents[s.agent]?.own
            ? [{ agent: s.agent, sessionId: s.sessionId }]
            : [],
      )
      // Each hit carries its row: main records it for a resume, the tab shows it even if its
      // own list is older (main strips the file path on the way).
      const post = (hit: SessionHit) => {
        const session = byKey.get(`${hit.agent}:${hit.sessionId}`)
        if (session) this.post({ id: req.id, hit: { ...hit, session } })
      }
      // One checker a store for this search (an open database), closed at the end. A store
      // that can't be searched is named, never read as "no matches".
      for (const a of new Set(files.filter((f) => !f.file).map((f) => f.agent))) {
        try {
          const c = this.agents[a]?.own?.searcher(req.query)
          if (c) checkers.set(a, c)
        } catch {
          failed.add(a)
        }
      }
      // The time allowed runs from here: a slow first listing isn't counted against the search.
      timer = setTimeout(() => {
        timedOut = true
        ctl.abort()
      }, SEARCH_MS)
      const { capped } = await searchFiles(files, req.query, {
        rg: req.rg,
        signal: ctl.signal,
        texts: (agent, line) => this.agents[agent]?.texts?.(line) ?? [],
        quick: (agent, raw) => this.agents[agent]?.quick?.(raw) ?? false,
        own: (f) => {
          const c = checkers.get(f.agent)
          if (!c || failed.has(f.agent)) return undefined
          try {
            return c.check(f.sessionId)
          } catch {
            failed.add(f.agent) // the store went wrong mid-search: say so, stop asking it
            return undefined
          }
        },
        onHit: post,
      })
      return {
        capped,
        ...(timedOut ? { timedOut } : {}),
        ...(failed.size ? { couldNot: [...failed] } : {}),
      }
    } finally {
      clearTimeout(timer)
      for (const c of checkers.values()) c.close()
      this.searches.delete(req.id)
    }
  }
}
