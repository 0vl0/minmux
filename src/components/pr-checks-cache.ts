// Each PR's last checks answer (per account), kept outside any view: shown at once when the PR
// is selected again, and read by the summary's chips (what the account may do to its branch).
import { useSyncExternalStore } from "react"
import type { PrRow } from "../lib/pr-dashboard"
import type { PrChecks } from "../lib/pr-checks"

const cache = new Map<string, PrChecks>()
const CACHE_MAX = 50
const listeners = new Set<() => void>()

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
