// Reviewer changes made from the pull requests dialog, kept outside it: whichever dialog is open
// (moved away and back, closed and reopened) shows a change in flight, its error, and the PR's
// row asked for directly after it (search answers lag behind edits).
import { useSyncExternalStore } from "react"
import { ipc } from "../lib/ipc"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import { EDIT_HOLD_MS, guessRow, type PrReviewersResult } from "../lib/pr-reviewers"

type Env = { cwd?: string; wsl?: { distro?: string } }

/** One PR's change: in flight (`busy`), its error, and its row while it's held. */
export interface PrEdit {
  busy: { login: string; add: boolean } | null
  error: { text: string; at: number } | null
  row: PrRow | null // asked for directly after the change (guessed if that failed)
  until: number // the row is shown over list answers until then
  seq: number // bumped by each change: an older direct answer doesn't replace a newer row
  fetching: boolean
}

const MAX = 50
const edits = new Map<string, PrEdit>()
const listeners = new Set<() => void>()
let version = 0

const put = (url: string, patch: Partial<PrEdit>) => {
  const e = edits.get(url) ?? {
    busy: null,
    error: null,
    row: null,
    until: 0,
    seq: 0,
    fetching: false,
  }
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

/** An error still worth showing (a later look at the PR may already show it fixed). */
export const editError = (e: PrEdit | undefined, now = Date.now()): string | null =>
  e?.error && now - e.error.at < EDIT_HOLD_MS ? e.error.text : null

/** Requests (or un-requests) a review: one change per PR at a time; never throws. */
export async function editReviewer(pr: PrRow, login: string, add: boolean, env: Env) {
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
  const prev = edits.get(pr.url)
  const row = res.row ?? guessRow(prev?.row ?? pr, login, add)
  put(pr.url, { busy: null, row, until: Date.now() + EDIT_HOLD_MS, seq: (prev?.seq ?? 0) + 1 })
}

/** The held rows, asked for again (after each list refresh: CI and merge state move on). */
export function refetchEdited(env: Env, now = Date.now()) {
  const due = [...edits].filter(([, e]) => e.row && !e.fetching && !e.busy && now < e.until)
  for (const [url, e] of due) {
    const { repo, number } = e.row!
    put(url, { fetching: true })
    void ipc
      .prRow({ repo, number, ...env })
      .catch(() => null)
      .then((row) => {
        const cur = edits.get(url)
        const fresh = row && cur?.seq === e.seq
        put(url, fresh ? { fetching: false, row } : { fetching: false })
      })
  }
}

/** The rows to show over list answers: PRs changed in the last EDIT_HOLD_MS. */
export const heldRows = (now = Date.now()): PrRow[] =>
  [...edits.values()].filter((e) => e.row && now < e.until).map((e) => e.row!)

/** Tests only: forget every edit. */
export const resetPrEdits = () => {
  edits.clear()
  version++
}
