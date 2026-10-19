import { useEffect, useRef, useState } from "react"
import { ArrowCounterClockwise, X } from "@phosphor-icons/react"
import { branchPr, forgetClose, prBranchState, recentCloses, usePrEdits } from "./pr-edits"
import { toDialog } from "./refocus-terminal"

const ERROR_MS = 2 * 60_000

/** PRs closed here lately: each with a way back, reopen (confirmed first), for a while. */
export function PrClosedBanner({ now, onReopened }: { now: number; onReopened: () => void }) {
  usePrEdits()
  const [asking, setAsking] = useState<string | null>(null) // the PR whose reopen is asked
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (asking) cancelRef.current?.focus() // (a held or doubled Enter never acts)
  }, [asking])
  const list = recentCloses(now)
  if (!list.length) return null
  return (
    <div className="pr-closed-banner">
      {list.map(({ row, env }) => {
        const state = prBranchState(row.url)
        const busy = state?.busy === "reopen"
        const failed =
          state?.error && !state.busy && now - state.error.at < ERROR_MS ? state.error.text : null
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
                  Closed <b>#{row.number}</b> {row.title}
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
