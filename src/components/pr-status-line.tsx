import { useEffect, useRef, useState } from "react"
import { Check, GitBranch } from "@phosphor-icons/react"
import { chipTone, statusParts, type PrRow } from "../lib/pr-dashboard"
import type { PrEnv } from "../lib/pr-reviewers"
import {
  behindText,
  BRANCH_WORD,
  chipAction,
  type PrBranchAction,
  type PrBranchOptions,
} from "../lib/pr-branch"
import { branchPr, prBranchState, usePrEdits } from "./pr-edits"
import { usePrChecks } from "./pr-checks-cache"

const SHOWN_MS = 2 * 60_000 // a done or failed action is said this long
const PENDING_MS = 2 * 60_000 // an update GitHub hasn't shown yet: not offered again meanwhile

/** Keys back to the dialog (the focused button is going away). */
const toDialog = (el: HTMLElement) => el.closest<HTMLElement>("[role=dialog]")?.focus()

/** One part of a PR's status line; "approved" gets its check mark. */
export function StatusChip({ part, title }: { part: string; title?: string }) {
  return (
    <span className={`pr-chip ${chipTone(part)}`} title={title}>
      {part === "approved" && <Check size={10} weight="bold" />}
      {part}
    </span>
  )
}

/** What a chip says on hover: its state, and what a click does (if anything). */
function chipTitle(part: string, row: PrRow, o: PrBranchOptions | undefined, can: boolean) {
  if (part === "behind base") {
    const what = behindText(o?.behind ?? null, row.base)
    if (can) return `${what} · click to update the branch (merges ${row.base} in)`
    return o ? `${what} · GitHub doesn't let this account update it` : what
  }
  if (part === "draft")
    return can ? "Draft · click to mark it ready for review" : "Draft: not ready for review"
  if (part === "open") return "Open · click to convert it back to a draft"
  return undefined
}

/** The detail's status line: its chips, the branch / draft ones clickable (confirmed first). */
export function PrStatusLine(
  props: PrEnv & {
    row: PrRow
    panes: string[] // the terminals it's checked out in (an update leaves them behind)
    onChanged?: () => void // done: the lists catch up
  },
) {
  const { row, panes, cwd, wsl, account, onChanged } = props
  usePrEdits()
  const opts = usePrChecks(row)?.branch
  const state = prBranchState(row.url)
  const [asking, setAsking] = useState<PrBranchAction | null>(null)
  // The confirm step starts on Cancel: a held or doubled Enter never acts.
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (asking) cancelRef.current?.focus()
  }, [asking])
  // The PR changed under an open confirm step: it's gone, never shown again later.
  useEffect(() => setAsking(null), [row.url, row.state, row.merge, account])

  const now = Date.now()
  const d = state?.done && now - state.done.at < SHOWN_MS ? state.done : null
  const updating =
    state?.busy === "update" ||
    (!!state?.done?.pending && now - state.done.at < PENDING_MS && row.merge === "behind")
  const error = state?.error && now - state.error.at < SHOWN_MS ? state.error.text : null
  const parts = statusParts(row)
  // (an open PR's own chip, only where it does something: back to draft)
  if (row.state === "open" && opts?.canEdit) parts.unshift("open")

  const go = async (action: PrBranchAction) => {
    setAsking(null)
    if (await branchPr(row, action, { cwd, wsl, account })) onChanged?.()
  }
  const as = account ? ` as @${account}` : ""

  return (
    <>
      <div className="pr-row-status">
        {parts.map((p) => {
          const action = state?.busy || updating ? null : chipAction(p, row, opts)
          const title = chipTitle(p, row, opts, !!action)
          if (p === "behind base" && updating)
            return (
              <span key={p} className="pr-chip warn" title={title}>
                updating branch…
              </span>
            )
          if (!action) return <StatusChip key={p} part={p} title={title} />
          return (
            <button
              key={p}
              className={`pr-chip pr-act ${chipTone(p)}`}
              title={title}
              aria-label={`${p}: ${BRANCH_WORD[action]}`}
              onClick={() => setAsking(action)}
            >
              {p}
            </button>
          )
        })}
      </div>
      {asking && (
        <div
          className="pr-merge pr-branch"
          onKeyDown={(e) => {
            // Esc leaves the confirm step, not the dialog
            if (e.key === "Escape") {
              e.preventDefault()
              e.stopPropagation()
              toDialog(e.currentTarget)
              setAsking(null)
            }
          }}
        >
          <span>
            {asking === "update"
              ? `Merge ${row.base} into ${row.head}${as}?`
              : asking === "ready"
                ? `Mark #${row.number} ready for review${as}? Its reviewers get notified.`
                : `Convert #${row.number} back to a draft${as}? It can't be merged until it's ready again.`}
          </span>
          {asking === "update" && panes.length > 0 && (
            <span className="pr-warn">Checked out in {panes.join(", ")}: pull there after.</span>
          )}
          <button
            className="pr-open good"
            onClick={(e) => {
              toDialog(e.currentTarget)
              void go(asking)
            }}
          >
            {asking === "update" && <GitBranch size={13} />} {BRANCH_WORD[asking]}
          </button>
          <button
            ref={cancelRef}
            className="pr-open"
            onClick={(e) => {
              toDialog(e.currentTarget)
              setAsking(null)
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {!asking && (state?.busy || d || error) && (
        <div className="pr-merge pr-branch">
          {state?.busy ? (
            <span className="pr-faint">
              {state.busy === "update"
                ? `Merging ${row.base} in…`
                : state.busy === "ready"
                  ? "Marking it ready for review…"
                  : "Converting it to a draft…"}
            </span>
          ) : error ? (
            <div className="pr-error">{error}</div>
          ) : d ? (
            <span className="pr-faint">
              {d.action === "update"
                ? d.pending
                  ? `GitHub is merging ${row.base} in: it'll show shortly.`
                  : `Branch updated: ${row.base} merged in.`
                : d.action === "ready"
                  ? "Marked ready for review."
                  : "Converted to a draft."}
            </span>
          ) : null}
        </div>
      )}
    </>
  )
}
