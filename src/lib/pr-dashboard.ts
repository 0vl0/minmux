// The pull requests dialog (docs/design/PR_DASHBOARD.md): the GraphQL query, its answer parsed
// into rows with their status, and pure helpers for the dialog. Shared with main (the query
// and parser run there); parsing never throws — gh's JSON is an outside format.

export type PrTab = "mine" | "review" | "repo"
export const PR_TABS: PrTab[] = ["mine", "review", "repo"]

export type PrRowState = "open" | "draft" | "merged" | "closed"
export type PrReview = "approved" | "changes" | "required" | null
export type PrMerge = "clean" | "behind" | "conflicts" | "blocked" | "unstable" | "unknown"
export type PrCi = "success" | "failure" | "pending" | null

/** One PR in a list, with what its status line shows. */
export interface PrRow {
  number: number
  title: string
  url: string
  repo: string // owner/name
  author: string
  state: PrRowState
  head: string
  base: string
  review: PrReview
  reviewers: { login: string; state: "approved" | "changes" | "commented" | "dismissed" }[]
  requested: string[] // logins, or org/team slugs
  merge: PrMerge
  ci: PrCi
  comments: number // conversation + review threads
  additions: number
  deletions: number
  updatedAt: string
}

/** A refresh's answer: each tab's rows (no repo tab when there's no repo). */
export interface PrLists {
  mine: PrRow[]
  review: PrRow[]
  repo?: PrRow[]
  repoName?: string // owner/name the repo tab lists
  warning?: string // a search that failed while the others answered
  remaining?: number // GraphQL points left this hour
  resetAt?: string
}

export type PrListsError = "missing" | "unauthenticated" | "offline" | "failed"

/** What main answers `prs:lists` with. */
export type PrListsResult =
  { ok: true; lists: PrLists } | { ok: false; error: PrListsError; message?: string }

/** A `prs:lists` request: the focused pane's checkout (for the repo tab and gh's environment). */
export interface PrListsRequest {
  cwd?: string
  wsl?: { distro?: string }
  closed: boolean // include PRs closed or merged in the last CLOSED_DAYS
}

export const PER_TAB = 30
export const CLOSED_DAYS = 14

export const PR_QUERY = `query($mine: String!, $review: String!, $repo: String!, $n: Int!, $withRepo: Boolean!) {
  mine: search(type: ISSUE, query: $mine, first: $n) { nodes { ...pr } }
  review: search(type: ISSUE, query: $review, first: $n) { nodes { ...pr } }
  repo: search(type: ISSUE, query: $repo, first: $n) @include(if: $withRepo) { nodes { ...pr } }
  rateLimit { remaining resetAt }
}
fragment pr on PullRequest {
  number title url state isDraft updatedAt
  author { login }
  repository { nameWithOwner }
  headRefName baseRefName
  reviewDecision mergeStateStatus
  additions deletions
  comments { totalCount }
  reviewThreads { totalCount }
  latestOpinionatedReviews(first: 10) { nodes { author { login } state } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { combinedSlug } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`

/** Each tab's search: open PRs, or (`closed`) any updated in the last CLOSED_DAYS. */
export function prSearches(
  repo: string | undefined,
  closed: boolean,
  now = Date.now(),
): Record<PrTab, string> {
  const since = new Date(now - CLOSED_DAYS * 86_400_000).toISOString().slice(0, 10)
  const scope = closed ? `updated:>=${since}` : "is:open"
  const q = (who: string) => `is:pr ${scope} ${who} sort:updated-desc`
  return {
    mine: q("author:@me"),
    review: q("review-requested:@me"),
    repo: repo ? q(`repo:${repo}`) : "",
  }
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const nodes = (v: unknown): unknown[] => {
  const n = obj(v)?.nodes
  return Array.isArray(n) ? n : []
}

const REVIEW: Record<string, PrReview> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "required",
}
const MERGE: Record<string, PrMerge> = {
  CLEAN: "clean",
  HAS_HOOKS: "clean",
  BEHIND: "behind",
  DIRTY: "conflicts",
  BLOCKED: "blocked",
  UNSTABLE: "unstable",
}
const CI: Record<string, PrCi> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
}
const REVIEWER: Record<string, PrRow["reviewers"][number]["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
}

/** One search node → a row (null: not a PR, or missing what a row needs). */
export function parsePrRow(v: unknown): PrRow | null {
  const o = obj(v)
  if (!o || typeof o.number !== "number" || !str(o.url)) return null
  const s = str(o.state)
  const state: PrRowState =
    s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : o.isDraft === true ? "draft" : "open"
  const reviewers: PrRow["reviewers"] = []
  for (const r of nodes(o.latestOpinionatedReviews)) {
    const login = str(obj(obj(r)?.author)?.login)
    const st = REVIEWER[str(obj(r)?.state)]
    if (login && st) reviewers.push({ login, state: st })
  }
  const requested: string[] = []
  for (const r of nodes(o.reviewRequests)) {
    const who = obj(obj(r)?.requestedReviewer)
    const name = str(who?.login) || str(who?.combinedSlug)
    if (name) requested.push(name)
  }
  const commit = obj(obj(nodes(o.commits)[0])?.commit)
  return {
    number: o.number,
    title: str(o.title),
    url: str(o.url),
    repo: str(obj(o.repository)?.nameWithOwner),
    author: str(obj(o.author)?.login),
    state,
    head: str(o.headRefName),
    base: str(o.baseRefName),
    review: REVIEW[str(o.reviewDecision)] ?? null,
    reviewers,
    requested,
    // GitHub computes it lazily: UNKNOWN (or none) until then — never shown as a problem.
    merge: MERGE[str(o.mergeStateStatus)] ?? "unknown",
    ci: CI[str(obj(commit?.statusCheckRollup)?.state)] ?? null,
    comments: num(obj(o.comments)?.totalCount) + num(obj(o.reviewThreads)?.totalCount),
    additions: num(o.additions),
    deletions: num(o.deletions),
    updatedAt: str(o.updatedAt),
  }
}

/** `gh api graphql` output → the lists (null: not an answer). */
export function parsePrLists(out: string, withRepo: boolean): PrLists | null {
  let root: unknown
  try {
    root = JSON.parse(out)
  } catch {
    return null
  }
  const data = obj(obj(root)?.data)
  if (!data) return null
  const rows = (k: string) =>
    nodes(data[k])
      .map(parsePrRow)
      .filter((r): r is PrRow => !!r)
  const lists: PrLists = { mine: rows("mine"), review: rows("review") }
  if (withRepo) lists.repo = rows("repo")
  const rate = obj(data.rateLimit)
  if (rate && typeof rate.remaining === "number") lists.remaining = rate.remaining
  if (rate && str(rate.resetAt)) lists.resetAt = str(rate.resetAt)
  return lists
}

/** A GitHub remote URL → owner/name (null: not github.com). */
export function githubRepoOf(remote: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    )
  return m ? `${m[1]}/${m[2]}` : null
}

/** The row's status line, in reading order (empty parts left out). */
export function statusParts(r: PrRow): string[] {
  const out: string[] = []
  if (r.state === "merged" || r.state === "closed") out.push(r.state)
  else {
    if (r.state === "draft") out.push("draft")
    if (r.review === "approved") out.push("approved")
    else if (r.review === "changes") out.push("changes requested")
    else if (r.requested.length) out.push(`review requested`)
    else if (r.review === "required") out.push("review required")
    if (r.merge === "behind") out.push("behind base")
    else if (r.merge === "conflicts") out.push("conflicts")
  }
  if (r.ci === "failure") out.push("CI failing")
  else if (r.ci === "pending") out.push("CI running")
  else if (r.ci === "success" && r.state !== "merged" && r.state !== "closed") out.push("CI passed")
  if (r.comments) out.push(`${r.comments} comment${r.comments === 1 ? "" : "s"}`)
  return out
}

// Backs off on errors (60 s → 5 min); waits for the reset when the budget runs low.
/** Milliseconds until the next automatic refresh. */
export function nextRefreshMs(lists: PrLists | null, failures: number, now = Date.now()): number {
  const EVERY = 60_000
  if (failures > 0) return Math.min(EVERY * 2 ** (failures - 1), 5 * 60_000)
  if (lists?.remaining !== undefined && lists.remaining < 500 && lists.resetAt) {
    const reset = Date.parse(lists.resetAt)
    if (Number.isFinite(reset) && reset > now) return Math.max(EVERY, reset - now)
  }
  return EVERY
}

/** Each PR url → the panes whose sidebar shows that PR (its branch is checked out there). */
// An agent's checkout key (`pane@in`) counts for its pane: its PR is checked out there too.
export function panesByPr(
  paneGit: Record<string, { pr?: { url: string } } | undefined>,
  isPane: (key: string) => boolean,
  paneOf: (key: string) => string = (k) => k,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [key, info] of Object.entries(paneGit)) {
    const url = info?.pr?.url
    if (!url || !isPane(key)) continue
    const pane = paneOf(key)
    const list = out.get(url)
    if (!list) out.set(url, [pane])
    else if (!list.includes(pane)) list.push(pane)
  }
  return out
}

/** A key's tab move (1/2/3 or ←/→), within the tabs shown. */
export function tabFor(key: string, cur: PrTab, tabs: PrTab[]): PrTab | null {
  if (key >= "1" && key <= "3") return tabs[Number(key) - 1] ?? null
  const i = tabs.indexOf(cur)
  if (key === "ArrowRight") return tabs[(i + 1) % tabs.length]!
  if (key === "ArrowLeft") return tabs[(i - 1 + tabs.length) % tabs.length]!
  return null
}
