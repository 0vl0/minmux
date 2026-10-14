// Reviewer changes made from the pull requests dialog, kept outside it: whichever dialog is open
// (moved away and back, closed and reopened) shows a change in flight, its error, and the PR's
// own row after it (shown over list copies older than it: search answers lag behind edits).
import { useSyncExternalStore } from "react"
import { ipc } from "../lib/ipc"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import { guessRow, HELD_MS, type PrEnv, type PrReviewersResult } from "../lib/pr-reviewers"

/** One PR's change: in flight (`busy`), its error, and its row after it. */
export interface PrEdit {
  busy: { login: string; add: boolean } | null
  error: { text: string; at: number } | null
  row: PrRow | null // asked for directly after the change (guessed if that failed)
  at: number // when `row` came
}

const MAX = 50
const ERROR_MS = 2 * 60_000 // a later look at the PR may show it fixed
const edits = new Map<string, PrEdit>()
const listeners = new Set<() => void>()
let version = 0

const put = (url: string, patch: Partial<PrEdit>) => {
  const e = edits.get(url) ?? { busy: null, error: null, row: null, at: 0 }
  edits.delete(url)
  edits.set(url, { ...e, ...patch })
  if (edits.size > MAX) edits.delete(edits.keys().next().value!)
  version++
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** Re-renders on every change to the edits (the answer is a version number). */
export const usePrEdits = (): number => useSyncExternalStore(subscribe, () => version)

export const prEdit = (url: string): PrEdit | undefined => edits.get(url)

/** An error still worth showing. */
export const editError = (e: PrEdit | undefined, now = Date.now()): string | null =>
  e?.error && now - e.error.at < ERROR_MS ? e.error.text : null

/** Requests (or un-requests) a review on `pr` (the row shown): one change per PR at a time. */
export async function editReviewer(pr: PrRow, login: string, add: boolean, env: PrEnv) {
  if (edits.get(pr.url)?.busy) return
  put(pr.url, { busy: { login, add }, error: null })
  const res = await ipc
    .prReviewers({
      repo: pr.repo,
      number: pr.number,
      add: add ? [login] : [],
      remove: add ? [] : [login],
      ...env,
    })
    .catch((): PrReviewersResult => ({ ok: false, error: "failed" }))
  if (!res.ok) return put(pr.url, { busy: null, error: { text: prErrorText(res), at: Date.now() } })
  // (guessed from the row on screen, which is this PR's own when it was changed before)
  put(pr.url, { busy: null, row: res.row ?? guessRow(pr, login, add), at: Date.now() })
}

/** A PR's own row after a change made elsewhere in the dialog (a review): shown the same way. */
export const holdRow = (row: PrRow) => put(row.url, { row, at: Date.now() })

/** The changed PRs' own rows (kept at most HELD_MS). */
export const heldRows = (now = Date.now()): PrRow[] =>
  [...edits.values()].filter((e) => e.row && now - e.at < HELD_MS).map((e) => e.row!)

/** Tests only: forget every edit. */
export const resetPrEdits = () => {
  edits.clear()
  version++
}
