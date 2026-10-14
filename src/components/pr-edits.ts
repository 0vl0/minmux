// Reviewer changes made from the pull requests dialog, kept outside it: whichever dialog is open
// (moved away and back, closed and reopened) shows a change in flight, its error, and the PR's
// own row after it (shown over list copies older than it: search answers lag behind edits).
import { useSyncExternalStore } from "react"
import { ipc } from "../lib/ipc"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import { guessRow, HELD_MS, type PrEnv, type PrReviewersResult } from "../lib/pr-reviewers"
import type { PrWriteAction, PrWriteResult } from "../lib/pr-write"

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

const notify = () => {
  version++
  for (const l of listeners) l()
}

const put = (url: string, patch: Partial<PrEdit>) => {
  const e = edits.get(url) ?? { busy: null, error: null, row: null, at: 0 }
  edits.delete(url)
  edits.set(url, { ...e, ...patch })
  if (edits.size > MAX) edits.delete(edits.keys().next().value!)
  notify()
}

/** A PR's comment or review: in flight, its error, or what went through. */
export interface PrWriteState {
  sending: PrWriteAction | null
  error: { text: string; at: number } | null
  done: { action: PrWriteAction; at: number } | null
}

// Per PR, outside any view (moving away and back, or reopening, mid-send still shows it, and
// never offers to send it twice). Drafts per PR and account: a reply composed as one account
// is never sent as another. Bounded.
const writes = new Map<string, PrWriteState>()
const drafts = new Map<string, string>()
const draftKey = (url: string, account: string | undefined) => `${url}\0${account ?? ""}`

const putWrite = (url: string, patch: Partial<PrWriteState>) => {
  const w = writes.get(url) ?? { sending: null, error: null, done: null }
  writes.delete(url)
  writes.set(url, { ...w, ...patch })
  if (writes.size > MAX) writes.delete(writes.keys().next().value!)
  notify()
}

export const prWriteState = (url: string): PrWriteState | undefined => writes.get(url)

/** The unsent reply for a PR as an account. */
export const draftOf = (url: string, account: string | undefined) =>
  drafts.get(draftKey(url, account)) ?? ""

export function setDraft(url: string, account: string | undefined, text: string) {
  const k = draftKey(url, account)
  drafts.delete(k)
  if (text) drafts.set(k, text)
  if (drafts.size > MAX) drafts.delete(drafts.keys().next().value!)
}

/** Sends a comment or review (one at a time per PR); true when it went through. */
export async function sendWrite(
  pr: PrRow,
  action: PrWriteAction,
  body: string,
  env: PrEnv,
): Promise<boolean> {
  if (writes.get(pr.url)?.sending) return false
  putWrite(pr.url, { sending: action, error: null, done: null })
  const res = await ipc
    .prWrite({ repo: pr.repo, number: pr.number, action, body, ...env })
    .catch((): PrWriteResult => ({ ok: false, error: "failed" }))
  if (!res.ok) {
    putWrite(pr.url, { sending: null, error: { text: prErrorText(res), at: Date.now() } })
    return false
  }
  setDraft(pr.url, env.account, "") // sent: even if its view has moved on
  if (res.row) put(pr.url, { row: res.row, at: Date.now() }) // the review decision, at once
  putWrite(pr.url, { sending: null, done: { action, at: Date.now() } })
  return true
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

/** The changed PRs' own rows (kept at most HELD_MS). */
export const heldRows = (now = Date.now()): PrRow[] =>
  [...edits.values()].filter((e) => e.row && now - e.at < HELD_MS).map((e) => e.row!)

/** Tests only: forget every edit. */
export const resetPrEdits = () => {
  edits.clear()
  writes.clear()
  drafts.clear()
  version++
}
