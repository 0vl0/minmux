// Each PR's last checks answer (per account), kept outside any view: shown at once when the PR
// is selected again, and read by the summary's chips (what the account may do to its branch).
import { useSyncExternalStore } from "react"
import type { PrRow } from "../lib/pr-dashboard"
import type { PrChecks } from "../lib/pr-checks"

const cache = new Map<string, PrChecks>()
const CACHE_MAX = 50
const listeners = new Set<() => void>()
const asks = new Map<string, number>() // per key: bumped to have its checks asked again

/** One key per PR and account: another account's answer never shows for it. */
export const checksKey = (row: PrRow) => `${row.url}\0${row.account ?? ""}`

export const cachedChecks = (key: string): PrChecks | undefined => cache.get(key)

/** Keeps an answer as the newest (bounded), and tells its readers. */
export function keepChecks(key: string, c: PrChecks) {
  cache.delete(key)
  cache.set(key, c)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** The PR's last checks answer, as its account (undefined: none yet). */
export const usePrChecks = (row: PrRow): PrChecks | undefined =>
  useSyncExternalStore(subscribe, () => cache.get(checksKey(row)))

/** An update's count, known before the checks are asked again: its chips stop offering it. */
export function knownBehind(key: string, behind: number) {
  const c = cache.get(key)
  if (!c) return
  const canUpdateBranch = behind > 0 && c.branch.canUpdateBranch
  keepChecks(key, { ...c, branch: { ...c.branch, behind, canUpdateBranch } })
}

/** Has the PR's checks (and its count) asked again, where they're shown. */
export function askChecksAgain(key: string) {
  asks.set(key, (asks.get(key) ?? 0) + 1)
  if (asks.size > CACHE_MAX) asks.delete(asks.keys().next().value!)
  for (const l of listeners) l()
}

/** How many times the PR's checks were asked for again (an effect's dependency). */
export const useChecksAsks = (key: string): number =>
  useSyncExternalStore(subscribe, () => asks.get(key) ?? 0)
