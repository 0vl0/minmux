import { useEffect, useRef, useState } from "react"
import { Check, ChatText, WarningCircle } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import type { PrEnv } from "../lib/pr-reviewers"
import { writeActions, type PrWriteAction, type PrWriteResult } from "../lib/pr-write"
import { holdRow } from "./pr-edits"

// Unsent text per PR while the app runs: moving to another PR and back keeps it. Bounded.
const drafts = new Map<string, string>()
const DRAFTS_MAX = 50

const BUSY_WORD: Record<PrWriteAction, string> = {
  comment: "Commenting…",
  approve: "Approving…",
  changes: "Requesting changes…",
}

/** A comment on the PR's conversation, or a review: approve, request changes. */
export function PrReply(props: PrEnv & { row: PrRow; onSent: () => void }) {
  const { row, cwd, wsl, account, onSent } = props
  const [text, setTextState] = useState(() => drafts.get(row.url) ?? "")
  const [busy, setBusy] = useState<PrWriteAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  const setText = (t: string) => {
    setTextState(t)
    setDone(null)
    drafts.delete(row.url)
    if (t) drafts.set(row.url, t)
    if (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value!)
  }

  const actions = writeActions(row, account)
  const empty = !text.trim()
  const send = async (action: PrWriteAction) => {
    if (busy || (empty && action !== "approve")) return
    setBusy(action)
    setError(null)
    const res = await ipc
      .prWrite({ repo: row.repo, number: row.number, action, body: text, cwd, wsl, account })
      .catch((): PrWriteResult => ({ ok: false, error: "failed" }))
    if (res.ok) {
      drafts.delete(row.url) // sent: even if this view has moved on
      if (res.row) holdRow(res.row) // the review decision shows at once
    }
    if (!alive.current) return
    setBusy(null)
    if (!res.ok) return setError(prErrorText(res))
    setTextState("")
    setDone(
      action === "approve"
        ? "Approved."
        : action === "changes"
          ? "Changes requested."
          : "Commented.",
    )
    onSent()
  }

  return (
    <div className="pr-reply">
      <textarea
        aria-label="Comment"
        placeholder={`Comment on #${row.number}${account ? ` as @${account}` : ""}…`}
        value={text}
        spellCheck
        rows={3}
        disabled={!!busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter comments; Esc leaves the box (the dialog's keys again), not the dialog
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send("comment")
          } else if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            e.currentTarget.closest<HTMLElement>("[role=dialog]")?.focus()
          }
        }}
      />
      {error && <div className="pr-error">{error}</div>}
      <div className="pr-reply-actions">
        <button
          className="pr-open"
          title="Comment on the pull request (⌘Enter)"
          disabled={!!busy || empty}
          onClick={() => void send("comment")}
        >
          <ChatText size={13} /> Comment
        </button>
        {actions.includes("approve") && (
          <button
            className="pr-open good"
            title="Approve, with the comment if there is one"
            disabled={!!busy}
            onClick={() => void send("approve")}
          >
            <Check size={13} weight="bold" /> Approve
          </button>
        )}
        {actions.includes("changes") && (
          <button
            className="pr-open bad"
            title={empty ? "Say what to change first" : "Request changes, with the comment"}
            disabled={!!busy || empty}
            onClick={() => void send("changes")}
          >
            <WarningCircle size={13} /> Request changes
          </button>
        )}
        <span className="pr-faint">{busy ? BUSY_WORD[busy] : done}</span>
      </div>
    </div>
  )
}
