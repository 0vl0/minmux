import { useEffect, useRef, useState } from "react"
import { GitMerge } from "@phosphor-icons/react"
import type { PrRow } from "../lib/pr-dashboard"
import type { PrChecks } from "../lib/pr-checks"
import type { PrEnv } from "../lib/pr-reviewers"
import { MERGE_WORD, mergeBlocked, startMethod, type PrMergeMethod } from "../lib/pr-merge"
import { mergePr, prMergeState, usePrEdits } from "./pr-edits"

const METHOD_KEY = "minmux.prDialog.mergeMethod" // per repo: the way picked last
const DONE_MS = 2 * 60_000

const readMethods = (): Record<string, string> => {
  try {
    const v = JSON.parse(localStorage.getItem(METHOD_KEY) ?? "{}") as unknown
    return v && typeof v === "object" ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}
const saveMethod = (repo: string, m: PrMergeMethod) => {
  try {
    localStorage.setItem(METHOD_KEY, JSON.stringify({ ...readMethods(), [repo.toLowerCase()]: m }))
  } catch {
    // per-viewer convenience only
  }
}

/** Merge the PR: one of the repo's ways (merge commit, squash, rebase), confirmed first. */
export function PrMergeBox(props: PrEnv & { row: PrRow; checks: PrChecks; onMerged?: () => void }) {
  const { row, checks, cwd, wsl, account, onMerged } = props
  usePrEdits()
  const opts = checks.merge
  const state = prMergeState(row.url)
  const merging = state?.merging ?? null
  const [method, setMethod] = useState<PrMergeMethod | null>(() =>
    opts ? startMethod(opts, readMethods()[row.repo.toLowerCase()] ?? null) : null,
  )
  const [confirm, setConfirm] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirm) confirmRef.current?.focus()
  }, [confirm])

  const now = Date.now()
  const done = state?.done && now - state.done.at < DONE_MS ? state.done : null
  if (done && !merging)
    return (
      <div className="pr-merge">
        <GitMerge size={14} className="pr-merged" /> Merged: {MERGE_WORD[done.method].toLowerCase()}
        .
      </div>
    )
  if (!opts || row.state === "merged" || row.state === "closed") return null
  const blocked = mergeBlocked(row, opts)
  if (blocked && !opts.canMerge) return null // (no write access: nothing to offer)
  const way = method && opts.methods.includes(method) ? method : startMethod(opts, null)
  const error = state?.error && now - state.error.at < DONE_MS ? state.error.text : null
  const failed = checks.checks.filter((c) => c.state === "failed").length
  const running = checks.checks.some((c) => c.state === "running")
  const caveat = failed
    ? `${failed} check${failed === 1 ? "" : "s"} failed.`
    : running
      ? "Checks are still running."
      : row.merge === "blocked"
        ? "GitHub may refuse: it needs approvals or required checks."
        : row.merge === "behind"
          ? "It's behind its base."
          : ""

  const go = async () => {
    if (!way || merging) return
    setConfirm(false)
    saveMethod(row.repo, way)
    if (await mergePr(row, way, opts.head, { cwd, wsl, account })) onMerged?.()
  }

  return (
    <div className="pr-merge">
      {confirm && way ? (
        <>
          <span>
            {MERGE_WORD[way]} #{row.number} into <code>{row.base}</code>
            {account ? ` as @${account}` : ""}?
          </span>
          {caveat && <span className="pr-warn">{caveat}</span>}
          <button
            ref={confirmRef}
            className="pr-open good"
            onClick={() => void go()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                setConfirm(false)
              }
            }}
          >
            <GitMerge size={13} /> Confirm merge
          </button>
          <button className="pr-open" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <select
            className="pr-accounts"
            aria-label="How to merge"
            title="How to merge (the repo's allowed ways)"
            value={way ?? ""}
            disabled={!!merging || !!blocked}
            onChange={(e) => {
              setMethod(e.target.value as PrMergeMethod)
              e.currentTarget.closest<HTMLElement>("[role=dialog]")?.focus()
            }}
          >
            {opts.methods.map((m) => (
              <option key={m} value={m}>
                {MERGE_WORD[m]}
              </option>
            ))}
          </select>
          <button
            className="pr-open good"
            title={blocked ?? `${way ? MERGE_WORD[way] : "Merge"} (asks to confirm)`}
            disabled={!!merging || !!blocked || !way}
            onClick={() => setConfirm(true)}
          >
            <GitMerge size={13} /> {merging ? "Merging…" : "Merge"}
          </button>
          {blocked ? (
            <span className="pr-faint">{blocked}</span>
          ) : (
            caveat && !merging && <span className="pr-faint">{caveat}</span>
          )}
        </>
      )}
      {error && <div className="pr-error">{error}</div>}
    </div>
  )
}
