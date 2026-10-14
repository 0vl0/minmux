// Reviewer changes made from the pull requests dialog, kept outside it: whichever dialog is open
// (moved away and back, closed and reopened) shows a change in flight, its error, and the PR's
// own row after it (shown over list copies older than it: search answers lag behind edits).
import { useSyncExternalStore } from "react"
import { ipc } from "../lib/ipc"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import { guessRow, HELD_MS, type PrEnv, type PrReviewersResult } from "../lib/pr-reviewers"
import { writeErrorText, type PrWriteAction, type PrWriteResult } from "../lib/pr-write"

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

/** A PR's comment or review: in flight (and as whom), its error, or what went through. */
export interface PrWriteState {
  sending: PrWriteAction | null
  as: string | undefined // the account it went out as (the picker may have moved since)
  error: { text: string; at: number } | null
  done: { action: PrWriteAction; at: number } | null
}

// Per PR, outside any view: moving away and back, or reopening, mid-send still shows it and
// never offers to send it twice. Drafts per PR and account (a reply composed as one account
// is never sent as another), each with a generation: a send that clears it bumps it, so any
// box holding a copy of the old text drops it. Bounded, never evicting a send in flight.
const writes = new Map<string, PrWriteState>()
const drafts = new Map<string, { text: string; gen: number }>()
let draftGen = 0

/** One draft per PR and account. */
export const draftKey = (url: string, account: string | undefined) => `${url}\0${account ?? ""}`

/** Sets a bounded map's entry as the newest; the oldest goes (never one `keep` holds on to). */
function boundedSet<V>(map: Map<string, V>, key: string, value: V, keep: (v: V) => boolean) {
  map.delete(key)
  map.set(key, value)
  if (map.size <= MAX) return
  for (const [k, v] of map)
    if (!keep(v)) {
      map.delete(k)
      return
    }
}

const putWrite = (url: string, patch: Partial<PrWriteState>) => {
  const w = writes.get(url) ?? { sending: null, as: undefined, error: null, done: null }
  boundedSet(writes, url, { ...w, ...patch }, (v) => !!v.sending)
  notify()
}

export const prWriteState = (url: string): PrWriteState | undefined => writes.get(url)

/** The unsent reply for a PR as an account, and its generation. */
export const draftOf = (url: string, account: string | undefined) =>
  drafts.get(draftKey(url, account)) ?? { text: "", gen: 0 }

/** Typing: kept quietly (no re-render of the dialog per key). */
export function setDraft(url: string, account: string | undefined, text: string) {
  const k = draftKey(url, account)
  const gen = drafts.get(k)?.gen ?? 0
  boundedSet(drafts, k, { text, gen }, () => false)
}

/** Sends a comment or review (one at a time per PR); true when it went through. */
export async function sendWrite(
  pr: PrRow,
  action: PrWriteAction,
  body: string,
  env: PrEnv,
): Promise<boolean> {
  if (writes.get(pr.url)?.sending) return false
  putWrite(pr.url, { sending: action, as: env.account, error: null, done: null })
  const res = await ipc
    .prWrite({ repo: pr.repo, number: pr.number, action, body, ...env })
    .catch((): PrWriteResult => ({ ok: false, error: "failed" }))
  if (!res.ok) {
    putWrite(pr.url, { sending: null, error: { text: writeErrorText(res), at: Date.now() } })
    return false
  }
  // Sent: the draft goes (a new generation: any box still holding it drops it), then the
  // PR's row (the review decision), then "done" last (the conversation reloads on it).
  boundedSet(drafts, draftKey(pr.url, env.account), { text: "", gen: ++draftGen }, () => false)
  if (res.row) put(pr.url, { row: res.row, at: Date.now() })
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
