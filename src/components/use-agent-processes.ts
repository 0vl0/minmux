import { useEffect, useState } from "react"
import { ipc } from "../lib/ipc"
import { POLL_MS, type AgentProcsResult } from "../lib/agent-processes"

/** One poller for every open list: each tick asks for all their panes at once (one snapshot),
 *  the next tick once the answer came. Nothing runs while no list is open. */
export function useAgentProcesses(open: ReadonlySet<string>): AgentProcsResult | null {
  const [result, setResult] = useState<AgentProcsResult | null>(null)
  const key = [...open].sort().join(",")
  useEffect(() => {
    if (!key) return setResult(null)
    const panes = key.split(",")
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () => {
      void ipc
        .agentProcesses(panes)
        .then((r) => live && setResult(r))
        .catch(() => live && setResult({ panes: {}, failed: true }))
        .finally(() => {
          if (live) timer = setTimeout(poll, POLL_MS)
        })
    }
    poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key])
  return result
}
