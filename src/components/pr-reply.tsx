import { useRef, useState } from "react"
import { Check, ChatText, WarningCircle } from "@phosphor-icons/react"
import type { PrRow } from "../lib/pr-dashboard"
import type { PrEnv } from "../lib/pr-reviewers"
import { BODY_MAX, writeActions, type PrWriteAction } from "../lib/pr-write"
import { draftOf, prWriteState, sendWrite, setDraft, usePrEdits } from "./pr-edits"

const BUSY_WORD: Record<PrWriteAction, string> = {
  comment: "Commenting…",
  approve: "Approving…",
  changes: "Requesting changes…",
}
const DONE_WORD: Record<PrWriteAction, string> = {
  comment: "Commented.",
  approve: "Approved.",
  changes: "Changes requested.",
}
const DONE_MS = 2 * 60_000 // (a "done" or an error; a later look at the PR says the rest)

// The sending state, its error and the draft live in pr-edits, per PR: this view can go and
// come back (or the dialog close and reopen) mid-send and still shows it, never a second send.
/** A comment on the PR's conversation, or a review: approve, request changes. */
export function PrReply(props: PrEnv & { row: PrRow }) {
  const { row, cwd, wsl, account } = props
  usePrEdits()
  const [, typed] = useState(0) // typing re-renders this box alone
  const state = prWriteState(row.url)
  const sending = state?.sending ?? null
  // The stored draft is the text (per PR and account): a send that went through, from this
  // box or one before it, empties every box showing it; another account's view has its own.
  const text = draftOf(row.url, account)
  const boxRef = useRef<HTMLTextAreaElement>(null)
  const setText = (t: string) => {
    setDraft(row.url, account, t)
    typed((n) => n + 1)
  }

  const actions = writeActions(row, account)
  const empty = !text.trim()
  const tooLong = text.length > BODY_MAX
  const send = async (action: PrWriteAction) => {
    if (sending || tooLong || (empty && action !== "approve")) return
    const focused = document.activeElement === boxRef.current
    await sendWrite(row, action, text, { cwd, wsl, account })
    // typing on goes to the box (never the dialog's keys), unless the focus went elsewhere
    if (focused && document.activeElement !== boxRef.current) {
      const now = document.activeElement
      if (!now || now === document.body || now.matches("[role=dialog]")) boxRef.current?.focus()
    }
  }

  const now = Date.now()
  // A write's outcome shows for the account it went out as, not beside another one's name.
  const mine = state?.as === account
  const error = mine && state?.error && now - state.error.at < DONE_MS ? state.error.text : null
  const done =
    mine && state?.done && now - state.done.at < DONE_MS
      ? state.done.already
        ? "Already there: not sent again."
        : DONE_WORD[state.done.action]
      : null
  const who = sending ? state?.as : account
  return (
    <div className="pr-reply">
      <textarea
        ref={boxRef}
        aria-label="Comment"
        placeholder={`Comment on #${row.number}…`}
        value={text}
        spellCheck
        rows={3}
        readOnly={!!sending} // (not disabled: the focus stays here)
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
      {tooLong && (
        <div className="pr-error">
          Too long for GitHub: {text.length.toLocaleString()} of {BODY_MAX.toLocaleString()}{" "}
          characters.
        </div>
      )}
      <div className="pr-reply-actions">
        <button
          className="pr-open"
          title="Comment on the pull request (⌘Enter)"
          disabled={!!sending || empty || tooLong}
          onClick={() => void send("comment")}
        >
          <ChatText size={13} /> Comment
        </button>
        {actions.includes("approve") && (
          <button
            className="pr-open good"
            title="Approve, with the comment if there is one"
            disabled={!!sending || tooLong}
            onClick={() => void send("approve")}
          >
            <Check size={13} weight="bold" /> Approve
          </button>
        )}
        {actions.includes("changes") && (
          <button
            className="pr-open bad"
            title={empty ? "Say what to change first" : "Request changes, with the comment"}
            disabled={!!sending || empty || tooLong}
            onClick={() => void send("changes")}
          >
            <WarningCircle size={13} /> Request changes
          </button>
        )}
        {/* who it goes out as, always in sight (not only in the empty box's placeholder) */}
        {/* (mid-send: the account it is going out as, whatever the picker says now) */}
        <span className="pr-faint">{who ? `as @${who}` : "as gh's active account"}</span>
        <span className="pr-faint">{sending ? BUSY_WORD[sending] : done}</span>
      </div>
    </div>
  )
}
