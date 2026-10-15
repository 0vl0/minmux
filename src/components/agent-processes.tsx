import { ArrowSquareOut, CaretDown, CaretRight } from "@phosphor-icons/react"
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

/** A pane's process rows (tree, CPU, memory, age, ports); the hover says how to end one. */
function ProcRows({ procs }: { procs: AgentProc[] }) {
  return (
    <>
      {procs.map((p) => (
        <div
          key={`${p.pid}:${p.started}`}
          className="agent-proc"
          style={{ paddingLeft: 18 + p.depth * 12 }}
          title={`${p.command}\npid ${p.pid}${p.detached ? "\nDetached: started by this agent, outside its process tree" : ""}\nTo end it: kill ${p.pid}`}
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
          {procs && <ProcRows procs={procs} />}
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
        <LeftGroup key={paneId} procs={procs} label={label(paneId)} />
      ))}
    </div>
  )
}

function LeftGroup({ procs, label }: { procs: AgentProc[]; label: string }) {
  return (
    <div className="agent-left-group">
      <div className="agent-left-head status-faint">
        <span className="agent-proc-cmd">{label}</span>
      </div>
      <ProcRows procs={procs} />
    </div>
  )
}
