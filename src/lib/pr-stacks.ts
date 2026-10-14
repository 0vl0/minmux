// Stacked PRs in the pull requests dialog (docs/design/PR_DASHBOARD.md, step 4): PR B is stacked
// on PR A when both are in the same repo and B's base branch is A's head branch. A list is shown
// as a forest, each stack under its bottom PR. Pure; works on the rows the lists already have.
import type { PrRow } from "./pr-dashboard"

/** One row of a list in stack order. */
export interface StackRow {
  row: PrRow
  depth: number // 0: a stack's bottom (or no stack)
  last: boolean // the last of its parent's PRs (the connector ends here)
  guides: boolean[] // per level above it (1..depth-1): an ancestor's line still runs on
  kids: boolean // PRs are stacked on it (its own line runs down to them)
  on: PrRow | null // its base PR when that isn't in this list (another tab has it)
}

// A fork's head branch lives in the fork: no PR in the base repo is based on it.
const headKey = (r: PrRow) => `${r.repo.toLowerCase()}\0${r.head}`
const baseKey = (r: PrRow) => `${r.repo.toLowerCase()}\0${r.base}`

const live = (r: PrRow) => r.state === "open" || r.state === "draft"

/** Each head branch → its PR: an open one over a closed or merged one, else the first listed. */
function byHead(rows: PrRow[]): Map<string, PrRow> {
  const out = new Map<string, PrRow>()
  for (const r of rows) {
    if (r.fork || !r.head) continue
    const had = out.get(headKey(r))
    if (!had || (live(r) && !live(had))) out.set(headKey(r), r)
  }
  return out
}

/** A row's base PR among `heads` (a PR is never its own base). */
export function basePr(row: PrRow, heads: Map<string, PrRow>): PrRow | null {
  const b = heads.get(baseKey(row))
  return b && b.url !== row.url ? b : null
}

/** A list in stack order: each PR right under the PR it's based on, in the list's own order. */
export function stackRows(rows: PrRow[], all: PrRow[] = rows): StackRow[] {
  const heads = byHead(rows)
  const allHeads = byHead(all)
  const kids = new Map<string, PrRow[]>()
  const roots: PrRow[] = []
  for (const r of rows) {
    const b = basePr(r, heads)
    if (!b) roots.push(r)
    else kids.set(b.url, [...(kids.get(b.url) ?? []), r])
  }
  const out: StackRow[] = []
  const seen = new Set<string>()
  const walk = (r: PrRow, depth: number, last: boolean, guides: boolean[]) => {
    if (seen.has(r.url)) return
    seen.add(r.url)
    const on = depth === 0 ? basePr(r, allHeads) : null
    const ks = (kids.get(r.url) ?? []).filter((k) => !seen.has(k.url))
    out.push({
      row: r,
      depth,
      last,
      guides,
      kids: ks.length > 0,
      on: on && !heads.has(headKey(on)) ? on : null,
    })
    // under a PR that has siblings below it, its line runs on past its children
    const next = depth > 0 ? [...guides, !last] : guides
    ks.forEach((k, i) => walk(k, depth + 1, i === ks.length - 1, next))
  }
  for (const r of roots) walk(r, 0, true, [])
  // A cycle (A on B, B on A) has no root: its PRs are listed flat, as they came.
  for (const r of rows) walk(r, 0, true, [])
  return out
}

/** `row`'s base PR among `rows` (null: based on a branch no listed PR has). */
export const baseOf = (row: PrRow, rows: PrRow[]): PrRow | null => basePr(row, byHead(rows))

/** The PRs stacked directly on `row`, among `rows`. */
export function stackedOn(row: PrRow, rows: PrRow[]): PrRow[] {
  if (row.fork) return []
  const heads = byHead(rows)
  return rows.filter((r) => basePr(r, heads)?.url === row.url)
}
