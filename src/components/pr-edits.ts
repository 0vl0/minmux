// Reviewer changes made from the pull requests dialog, kept outside it: whichever dialog is open
// (moved away and back, closed and reopened) shows a change in flight, its error, and the PR's
// own row after it (shown over list copies older than it: search answers lag behind edits).
import { useSyncExternalStore } from "react"
import { ipc } from "../lib/ipc"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import { guessRow, HELD_MS, type PrEnv, type PrReviewersResult } from "../lib/pr-reviewers"
import { writeErrorText, type PrWriteAction, type PrWriteResult } from "../lib/pr-write"
import type { PrMergeMethod, PrMergeResult } from "../lib/pr-merge"

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
  as: string | undefined // the account the last one went out as (the picker may move since)
  error: { text: string; at: number } | null
  done: { action: PrWriteAction; at: number; already: boolean } | null
  seq: number // each finished write, through or not: the conversation is asked for again
}

// Per PR, outside any view: moving away and back, or reopening, mid-send still shows it and
// never offers to send it twice (main also joins a write already running, and checks GitHub
// before retrying one that ended unclear). Drafts per PR and account: a reply composed as one
// account is never sent as another. The stored draft is the box's text, nothing else.
// Bounded: a send in flight is never dropped; drafts keep the newest DRAFTS_MAX.
const writes = new Map<string, PrWriteState>()
let writeSeq = 0
const drafts = new Map<string, string>()
const DRAFTS_MAX = 500 // (empty ones aren't kept: only real text counts)

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
  const w = writes.get(url) ?? { sending: null, as: undefined, error: null, done: null, seq: 0 }
  boundedSet(writes, url, { ...w, ...patch }, (v) => !!v.sending)
  notify()
}

export const prWriteState = (url: string): PrWriteState | undefined => writes.get(url)

/** The unsent reply for a PR as an account. */
export const draftOf = (url: string, account: string | undefined) =>
  drafts.get(draftKey(url, account)) ?? ""

/** Typing: kept quietly (the box re-renders itself, not every view of the store). */
export function setDraft(url: string, account: string | undefined, text: string) {
  const k = draftKey(url, account)
  if (!text) drafts.delete(k)
  else {
    drafts.delete(k)
    drafts.set(k, text)
    if (drafts.size > DRAFTS_MAX) drafts.delete(drafts.keys().next().value!)
  }
}

/** Sends a comment or review (one at a time per PR). */
export async function sendWrite(pr: PrRow, action: PrWriteAction, body: string, env: PrEnv) {
  if (writes.get(pr.url)?.sending) return
  putWrite(pr.url, { sending: action, as: env.account, error: null })
  const res = await ipc
    .prWrite({ repo: pr.repo, number: pr.number, action, body, ...env })
    .catch((): PrWriteResult => ({ ok: false, error: "failed" }))
  const seq = ++writeSeq // (app-wide: never lower than any seq a cached answer carries)
  if (!res.ok) {
    putWrite(pr.url, {
      sending: null,
      error: { text: writeErrorText(res), at: Date.now() },
      done: null, // (an earlier "Commented." doesn't stand beside this failure)
      seq,
    })
    return
  }
  drafts.delete(draftKey(pr.url, env.account)) // sent: every box showing it empties
  if (res.row) put(pr.url, { row: res.row, at: Date.now() }) // the review decision, at once
  putWrite(pr.url, {
    sending: null,
    done: { action, at: Date.now(), already: !!res.already },
    seq,
  })
}

/** A PR's merge: in flight (which way), its error, or done. */
export interface PrMergeState {
  merging: PrMergeMethod | null
  error: { text: string; at: number } | null
  done: { method: PrMergeMethod; at: number } | null
}

// Per PR, outside any view (as writes): moving away and back mid-merge still shows it.
const merges = new Map<string, PrMergeState>()

const putMerge = (url: string, patch: Partial<PrMergeState>) => {
  const m = merges.get(url) ?? { merging: null, error: null, done: null }
  boundedSet(merges, url, { ...m, ...patch }, (v) => !!v.merging)
  notify()
}

export const prMergeState = (url: string): PrMergeState | undefined => merges.get(url)

/** Merges a PR (one at a time per PR); its row after shows it merged in the lists at once. */
export async function mergePr(pr: PrRow, method: PrMergeMethod, head: string, env: PrEnv) {
  if (merges.get(pr.url)?.merging) return false
  putMerge(pr.url, { merging: method, error: null, done: null })
  const res = await ipc
    .prMerge({ repo: pr.repo, number: pr.number, method, head: head || undefined, ...env })
    .catch((): PrMergeResult => ({ ok: false, error: "failed" }))
  if (!res.ok) {
    putMerge(pr.url, { merging: null, error: { text: writeErrorText(res), at: Date.now() } })
    return false
  }
  // (no row back: the merge went through, the fetch didn't; shown merged meanwhile)
  const row = res.row ?? { ...pr, state: "merged" as const, updatedAt: new Date().toISOString() }
  put(pr.url, { row, at: Date.now() })
  putMerge(pr.url, { merging: null, done: { method, at: Date.now() } })
  return true
}

/** Re-renders when a write on this PR finishes (its number goes up), nothing else. */
export const usePrWriteSeq = (url: string): number =>
  useSyncExternalStore(subscribe, () => writes.get(url)?.seq ?? 0)

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
  merges.clear()
  drafts.clear()
  version++
}
