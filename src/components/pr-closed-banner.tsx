import { useEffect, useRef, useState } from "react"
import { ArrowCounterClockwise, X } from "@phosphor-icons/react"
import type { PrRow } from "../lib/pr-dashboard"
import {
  branchError,
  branchPr,
  forgetClose,
  prBranchState,
  recentCloses,
  usePrEdits,
} from "./pr-edits"
import { toDialog } from "./refocus-terminal"

// (a PR the lists show, Include closed on, has its own reopen on its status line: not here)
/** PRs closed here lately and gone from the lists: each with a way back, reopen (confirmed). */
export function PrClosedBanner(props: {
  now: number
  listed: PrRow[] // every PR the lists show
  onReopened: () => void
}) {
  const { now, listed, onReopened } = props
  usePrEdits()
  const [asking, setAsking] = useState<string | null>(null) // the PR whose reopen is asked
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (asking) cancelRef.current?.focus() // (a held or doubled Enter never acts)
  }, [asking])
  const shown = new Set(listed.map((r) => r.url))
  const list = recentCloses(now).filter((c) => !shown.has(c.row.url))
  const askingShown = !!asking && list.some((c) => c.row.url === asking)
  // its PR gone from the banner (reopened elsewhere, dismissed, run out): never asked later
  useEffect(() => {
    if (asking && !askingShown) setAsking(null)
  }, [asking, askingShown])
  if (!list.length) return null
  return (
    <div className="pr-closed-banner">
      {list.map(({ row, env }) => {
        const state = prBranchState(row.url)
        const busy = state?.busy === "reopen"
        const failed = branchError(state, now)
        const as = env.account ? ` as @${env.account}` : ""
        return (
          <div key={row.url} className="pr-closed-item">
            {asking === row.url ? (
              <span
                className="pr-merge"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault()
                    e.stopPropagation()
                    toDialog(e.currentTarget)
                    setAsking(null)
                  }
                }}
              >
                <span>
                  Reopen #{row.number}
                  {as}?
                </span>
                <button
                  className="pr-open good"
                  onClick={async (e) => {
                    toDialog(e.currentTarget)
                    setAsking(null)
                    if (await branchPr(row, "reopen", env)) onReopened()
                  }}
                >
                  Reopen pull request
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
              </span>
            ) : (
              <>
                <span>
                  Closed{" "}
                  <b>
                    {row.repo}#{row.number}
                  </b>{" "}
                  {row.title}
                </span>
                {busy ? (
                  <span className="pr-faint">Reopening it…</span>
                ) : (
                  <button
                    className="pr-open"
                    title={`Reopen #${row.number}${as} (asks first)`}
                    onClick={() => setAsking(row.url)}
                  >
                    <ArrowCounterClockwise size={13} /> Reopen
                  </button>
                )}
                {failed && <span className="pr-error">{failed}</span>}
                <button
                  className="iconbtn pr-closed-dismiss"
                  title="Dismiss"
                  aria-label={`Dismiss: closed #${row.number}`}
                  onClick={(e) => {
                    toDialog(e.currentTarget)
                    forgetClose(row.url)
                  }}
                >
                  <X size={12} />
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
