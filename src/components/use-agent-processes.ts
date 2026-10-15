import { useEffect, useState } from "react"
import { ipc } from "../lib/ipc"
import { LEFTOVERS_POLL_MS, POLL_MS, type AgentProcsResult } from "../lib/agent-processes"

/** One poller for the open lists (every POLL_MS) and, else, what's left running (LEFTOVERS_POLL_MS). */
export function useAgentProcesses(
  open: ReadonlySet<string>,
  leftovers: boolean,
): AgentProcsResult | null {
  const [result, setResult] = useState<AgentProcsResult | null>(null)
  const openKey = [...open].sort().join(",")
  useEffect(() => {
    if (!openKey && !leftovers) return setResult(null)
    const panes = openKey ? openKey.split(",") : []
    const every = panes.length ? POLL_MS : LEFTOVERS_POLL_MS
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = () => {
      // A hidden window asks nothing (no one sees it); the next tick after it's shown does.
      if (document.visibilityState === "hidden") {
        timer = setTimeout(poll, every)
        return
      }
      void ipc
        .agentProcesses(panes)
        .then((r) => live && setResult(r))
        // Failed: the lists say so; what's left running stays as last read (not "all exited").
        .catch(
          () => live && setResult((r) => ({ panes: {}, failed: true, leftovers: r?.leftovers })),
        )
        .finally(() => {
          if (live) timer = setTimeout(poll, every)
        })
    }
    poll()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [openKey, leftovers])
  return result
}
