// What each agent session is running (docs/design/AGENT_PROCESSES.md): the rows main sends for a
// pane's agent processes, and how the Live tab shows them.

/** One process an agent started (or started from its pane and detached). */
export interface AgentProc {
  pid: number
  ppid: number
  command: string // the full command line
  comm: string // the program's name
  cpu: number // %
  rssKb: number
  started: number // ms: with the pid, which process this is (a reused pid has another start)
  depth: number // in the tree under the agent (0 = its direct child)
  detached?: true // found by the pane marker, outside the pane's process tree
}

/** Per pane: its agents' processes; `failed` when the snapshot couldn't be taken. */
export interface AgentProcsResult {
  panes: Record<string, AgentProc[]>
  failed?: boolean
}

export const POLL_MS = 2500

/** The command without its program's directory, capped for a row. */
export function shortCommand(p: Pick<AgentProc, "command" | "comm">, max = 120): string {
  const rest = p.command.trim().replace(/^\S+/, "").trim()
  const line = rest ? `${p.comm} ${rest}` : p.comm
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** "12%", "0.4%" (one decimal under 10). */
export const cpuText = (cpu: number): string => `${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}%`

/** "210 MB", "1.2 GB". */
export function memText(rssKb: number): string {
  const mb = rssKb / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** The processes' total CPU, for the collapsed row. */
export const totalCpu = (procs: AgentProc[]): number => procs.reduce((n, p) => n + p.cpu, 0)
