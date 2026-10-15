import { useState } from "react"
import { ArrowSquareOut, CaretDown, CaretRight, X } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import {
  cpuText,
  LEFTOVERS_POLL_MS,
  memText,
  shortCommand,
  totalCpu,
  type AgentProc,
  type AgentProcsResult,
} from "../lib/agent-processes"
import { ago } from "../lib/past-sessions"

// SIGTERM, then SIGKILL after 3 s: a row still there past this (and a poll since) can be ended
// again. Left running is polled every 10 s, so it waits longer.
const RETRY_MS = 5000
const LEFT_RETRY_MS = LEFTOVERS_POLL_MS + RETRY_MS

// Refused by main: usable at once; still listed `retryMs` after (it survived): usable again.
/** Rows being ended (by pid and start: a reused pid isn't), and ending one. */
function useEnding(paneId: string, retryMs = RETRY_MS) {
  const [ending, setEnding] = useState<Set<string>>(new Set())
  const keyOf = (p: AgentProc) => `${p.pid}:${p.started}`
  const end = (p: AgentProc) => {
    const key = keyOf(p)
    setEnding((s) => new Set(s).add(key))
    const undo = () =>
      setEnding((s) => {
        if (!s.has(key)) return s
        const next = new Set(s)
        next.delete(key)
        return next
      })
    void ipc
      .killAgentProcess(paneId, p.pid, p.started)
      .then((ok) => (ok ? setTimeout(undo, retryMs) : undo()), undo)
  }
  return { isEnding: (p: AgentProc) => ending.has(keyOf(p)), end }
}

/** A pane's process rows: the tree, CPU, memory, age, listening ports, and the end button. */
function ProcRows({
  procs,
  ending: { isEnding, end },
}: {
  procs: AgentProc[]
  ending: ReturnType<typeof useEnding>
}) {
  return (
    <>
      {procs.map((p) => (
        <div
          key={`${p.pid}:${p.started}`}
          className={`agent-proc${isEnding(p) ? " ending" : ""}`}
          style={{ paddingLeft: 18 + p.depth * 12 }}
          title={`${p.command}\npid ${p.pid}${p.detached ? "\nDetached: started by this agent, outside its process tree" : ""}`}
        >
          <span className="agent-proc-cmd">
            {shortCommand(p)}
            {p.detached && <span className="status-faint"> (detached)</span>}
          </span>
          {p.ports?.map((port) => (
            <button
              key={port}
              className="agent-proc-port"
              title={`Open http://localhost:${port} in the browser`}
              onClick={() => ipc.openExternal(`http://localhost:${port}`)}
            >
              :{port} <ArrowSquareOut size={9} />
            </button>
          ))}
          <span className="agent-proc-num">{cpuText(p.cpu)}</span>
          <span className="agent-proc-num">{memText(p.rssKb)}</span>
          <span className="agent-proc-num">{ago(p.started)}</span>
          <button
            className="iconbtn agent-proc-kill"
            title={
              p.holdsAgent
                ? "An agent runs under it: end that agent first"
                : "End it and what it started (SIGTERM, then SIGKILL)"
            }
            disabled={isEnding(p) || p.holdsAgent}
            onClick={() => end(p)}
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </>
  )
}

/** The processes an agent session runs, at the end of its block in the Live tab. */
export function AgentProcesses({
  paneId,
  open,
  onToggle,
  result,
}: {
  paneId: string
  open: boolean
  onToggle: () => void
  result: AgentProcsResult | null // the shared poll's answer (null: none yet)
}) {
  const ending = useEnding(paneId)
  // Open: its rows once a poll answered for it (one that ran before it was opened, for what's
  // left running, didn't: still reading).
  const procs = open && result && !result.failed ? result.panes[paneId] : undefined
  // The count only while open: a closed list isn't polled, so it would go stale.
  const count = procs?.length
  const cpu = procs ? totalCpu(procs) : 0
  return (
    <div className="agent-procs">
      <button
        className="agent-procs-toggle status-faint"
        aria-expanded={open}
        title={open ? "Hide the processes this agent runs" : "Show the processes this agent runs"}
        onClick={onToggle}
      >
        {open ? <CaretDown size={10} /> : <CaretRight size={10} />}
        {count === undefined
          ? "processes"
          : `${count} process${count === 1 ? "" : "es"}${cpu >= 1 ? ` · ${cpuText(cpu)} CPU` : ""}`}
      </button>
      {open && (
        <div className="agent-procs-list">
          {!procs && !result?.failed && (
            <div className="status-faint agent-procs-note">Reading…</div>
          )}
          {result?.failed && (
            <div className="status-faint agent-procs-note">Couldn't read the processes.</div>
          )}
          {procs?.length === 0 && (
            <div className="status-faint agent-procs-note">Nothing running.</div>
          )}
          {procs && <ProcRows procs={procs} ending={ending} />}
        </div>
      )}
    </div>
  )
}

/** What agents left running after they ended (or their pane closed), per pane, in the Live tab. */
export function LeftRunning({
  result,
  label,
}: {
  result: AgentProcsResult | null
  label: (paneId: string) => string // the pane's title, or that it's closed
}) {
  const groups = Object.entries(result?.leftovers ?? {}).filter(([, procs]) => procs.length)
  if (!groups.length) return null
  return (
    <div className="agent-left">
      <div className="agents-pane-label status-faint">Left running</div>
      {groups.map(([paneId, procs]) => (
        <LeftGroup key={paneId} paneId={paneId} procs={procs} label={label(paneId)} />
      ))}
    </div>
  )
}

function LeftGroup({
  paneId,
  procs,
  label,
}: {
  paneId: string
  procs: AgentProc[]
  label: string
}) {
  const ending = useEnding(paneId, LEFT_RETRY_MS)
  // The ones not already being ended (a second click doesn't signal them twice).
  const tops = procs.filter((p) => p.depth === 0 && !ending.isEnding(p) && !p.holdsAgent)
  return (
    <div className="agent-left-group">
      <div className="agent-left-head status-faint">
        <span className="agent-proc-cmd">{label}</span>
        <button
          className="agent-left-all"
          title="End all of them and what they started"
          disabled={!tops.length}
          onClick={() => tops.forEach(ending.end)}
        >
          End all
        </button>
      </div>
      <ProcRows procs={procs} ending={ending} />
    </div>
  )
}
