import { useState } from "react"
import { CaretDown, CaretRight, X } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import {
  cpuText,
  memText,
  shortCommand,
  totalCpu,
  type AgentProc,
  type AgentProcsResult,
} from "../lib/agent-processes"
import { ago } from "../lib/past-sessions"

// SIGTERM, then SIGKILL after 3 s: a row still there past this can be ended again.
const RETRY_MS = 5000

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
  // Open: its rows once the shared poll answered (a pane it couldn't attribute: none).
  const procs = open && result && !result.failed ? (result.panes[paneId] ?? []) : undefined
  // Rows being ended (by pid and start: a reused pid isn't), dimmed. Refused by main: usable at
  // once; still listed a while after (it survived): usable again, to retry.
  const [ending, setEnding] = useState<Set<string>>(new Set())
  const keyOf = (p: AgentProc) => `${p.pid}:${p.started}`
  const kill = (p: AgentProc) => {
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
      .then((ok) => (ok ? setTimeout(undo, RETRY_MS) : undo()), undo)
  }

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
          {!result && <div className="status-faint agent-procs-note">Reading…</div>}
          {result?.failed && (
            <div className="status-faint agent-procs-note">Couldn't read the processes.</div>
          )}
          {procs?.length === 0 && (
            <div className="status-faint agent-procs-note">Nothing running.</div>
          )}
          {procs?.map((p) => (
            <div
              key={`${p.pid}:${p.started}`}
              className={`agent-proc${ending.has(keyOf(p)) ? " ending" : ""}`}
              style={{ paddingLeft: 18 + p.depth * 12 }}
              title={`${p.command}\npid ${p.pid}${p.detached ? "\nDetached: started by this agent, outside its process tree" : ""}`}
            >
              <span className="agent-proc-cmd">
                {shortCommand(p)}
                {p.detached && <span className="status-faint"> (detached)</span>}
              </span>
              <span className="agent-proc-num">{cpuText(p.cpu)}</span>
              <span className="agent-proc-num">{memText(p.rssKb)}</span>
              <span className="agent-proc-num">{ago(p.started)}</span>
              <button
                className="iconbtn agent-proc-kill"
                title="End it and what it started (SIGTERM, then SIGKILL)"
                disabled={ending.has(keyOf(p))}
                onClick={() => kill(p)}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
