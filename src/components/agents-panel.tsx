import { X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { AgentsList } from "./agents-list"

/** Right-side board of coding agents: the sessions in open panes, grouped like the sidebar,
 *  then every other past session (docs/design/AGENTS_PANEL.md). */
export function AgentsPanel() {
  const close = () => useStore.getState().setRightView(null)
  return (
    <div className="diffpanel">
      <div className="diffpanel-header">
        <span className="section-label">Agents</span>
        <button className="iconbtn" style={{ width: 22, height: 22 }} title="Close" onClick={close}>
          <X size={13} />
        </button>
      </div>
      <AgentsList />
    </div>
  )
}
