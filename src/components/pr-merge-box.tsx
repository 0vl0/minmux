import { useEffect, useRef, useState } from "react"
import { GitMerge } from "@phosphor-icons/react"
import type { PrRow } from "../lib/pr-dashboard"
import type { PrChecks } from "../lib/pr-checks"
import type { PrEnv } from "../lib/pr-reviewers"
import { MERGE_WORD, mergeBlocked, startMethod, type PrMergeMethod } from "../lib/pr-merge"
import { mergePr, prBranchState, prMergeState, usePrEdits } from "./pr-edits"
import { toDialog } from "./refocus-terminal"

const METHOD_KEY = "minmux.prDialog.mergeMethod" // per repo: the way picked last
const DONE_MS = 2 * 60_000
const QUEUED_MS = 30 * 60_000 // a merge queue's: said while the PR stays open (not offered again)

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
export function PrMergeBox(
  props: PrEnv & {
    row: PrRow
    checks: PrChecks
    onMerged?: () => void
    onFailed?: () => void // its checks asked again (a push since: the head pinned is stale)
  },
) {
  const { row, checks, cwd, wsl, account, onMerged, onFailed } = props
  usePrEdits()
  const opts = checks.merge
  const state = prMergeState(row.url)
  const merging = state?.merging ?? null
  const [method, setMethod] = useState<PrMergeMethod | null>(() =>
    opts ? startMethod(opts, readMethods()[row.repo.toLowerCase()] ?? null) : null,
  )
  const [confirm, setConfirm] = useState(false)
  // The confirm step starts on Cancel: a held or doubled Enter never merges.
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirm) cancelRef.current?.focus()
  }, [confirm])
  // The PR or its merge changed under an open confirm step: it's gone, never shown again later.
  const branchBusy = !!prBranchState(row.url)?.busy
  useEffect(() => setConfirm(false), [merging, row.state, row.merge, opts?.head, branchBusy])

  const now = Date.now()
  const d = state?.done
  const queued = !!d && !d.merged && row.state !== "merged" && row.state !== "closed"
  const done = d && now - d.at < (queued ? QUEUED_MS : DONE_MS) ? d : null
  if (done && !merging)
    return (
      <div className="pr-merge">
        <GitMerge size={14} className="pr-merged" />{" "}
        {done.already
          ? "It was already merged."
          : done.merged
            ? `Merged: ${MERGE_WORD[done.method].toLowerCase()}.`
            : "GitHub took the merge but hasn't made it yet (a merge queue, or it's on its way)."}
      </div>
    )
  if (!opts || !opts.canMerge || row.state === "merged" || row.state === "closed") return null
  // (one write on a PR at a time: its branch update or draft change first)
  const blocked = prBranchState(row.url)?.busy
    ? "Another change to it is running."
    : mergeBlocked(row, opts)
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
    if (!way || merging || blocked) return
    setConfirm(false)
    saveMethod(row.repo, way)
    if (await mergePr(row, way, opts.head, { cwd, wsl, account })) onMerged?.()
    else onFailed?.()
  }

  const asking = confirm && !!way && !blocked && !merging
  return (
    <div
      className="pr-merge"
      onKeyDown={(e) => {
        // Esc leaves the confirm step, not the dialog
        if (asking && e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          toDialog(e.currentTarget)
          setConfirm(false)
        }
      }}
    >
      {asking && way ? (
        <>
          <span>
            {MERGE_WORD[way]} #{row.number} into <code>{row.base}</code>
            {account ? ` as @${account}` : ""}?
          </span>
          {caveat && <span className="pr-warn">{caveat}</span>}
          <button
            className="pr-open good"
            onClick={(e) => {
              toDialog(e.currentTarget)
              void go()
            }}
          >
            <GitMerge size={13} /> Confirm merge
          </button>
          <button
            ref={cancelRef}
            className="pr-open"
            onClick={(e) => {
              toDialog(e.currentTarget)
              setConfirm(false)
            }}
          >
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
              toDialog(e.currentTarget)
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
