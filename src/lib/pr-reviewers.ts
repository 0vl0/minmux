// The pull requests dialog's reviewer picker (docs/design/PR_DASHBOARD.md, step 3): who can
// review a PR (GitHub's suggestions, the repo's assignable people, the org's teams), and adding
// or removing a request. Shared with main; parsing never throws (gh's JSON is an outside format).
import { nodes, obj, str, type PrListsError, type PrRow } from "./pr-dashboard"

/** A person or team the picker offers. */
export interface PrCandidate {
  login: string // a user's login, or a team's org/slug
  name: string
  team: boolean
  suggested: boolean // GitHub's suggestion (wrote or commented on the changed lines)
}

/** The picker's answer. `teams`: "no-scope" when gh's token lacks read:org; null: not an org. */
export interface PrCandidates {
  suggested: PrCandidate[]
  people: PrCandidate[]
  teams: PrCandidate[] | "no-scope" | null
}

/** A `prs:candidates` request: the PR, the search text, and where gh runs. */
export interface PrCandidatesRequest {
  repo: string // owner/name
  number: number
  query: string
  cwd?: string
  wsl?: { distro?: string }
}

export type PrCandidatesResult =
  { ok: true; candidates: PrCandidates } | { ok: false; error: PrListsError; message?: string }

/** A `prs:reviewers` request: logins (or org/team slugs) to request, and to un-request. */
export interface PrReviewersRequest {
  repo: string
  number: number
  add: string[]
  remove: string[]
  cwd?: string
  wsl?: { distro?: string }
}

// `row`: the PR fetched again after the edit (null: the edit went through, the fetch didn't).
export type PrReviewersResult =
  { ok: true; row: PrRow | null } | { ok: false; error: PrListsError; message?: string }

export const CANDIDATES = 20
export const QUERY_MAX = 100

export const PR_CANDIDATES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $q: String!, $suggest: Boolean!, $teams: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) @include(if: $suggest) {
      suggestedReviewers { reviewer { login name } }
    }
    assignableUsers(query: $q, first: ${CANDIDATES}) { nodes { login name } }
  }
  repositoryOwner(login: $owner) @include(if: $teams) {
    __typename
    ... on Organization { teams(query: $q, first: ${CANDIDATES}) { nodes { combinedSlug name } } }
  }
}`

/** A login or org/team slug gh can take as one argument (never an option, never a list). */
// (`_`: Enterprise Managed Users' logins end in _shortcode)
export function isReviewer(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9][\w-]*(?:\/[A-Za-z0-9][\w.-]*)?$/.test(v)
}

/** `gh api graphql` output → the candidates (null: not an answer). */
export function parseCandidates(out: string, teams: boolean): PrCandidates | null {
  let root: unknown
  try {
    root = JSON.parse(out)
  } catch {
    return null
  }
  const data = obj(obj(root)?.data)
  const repo = obj(data?.repository)
  if (!data || !repo) return null
  const user = (v: unknown, suggested: boolean): PrCandidate | null => {
    const o = obj(v)
    const login = str(o?.login)
    return isReviewer(login) ? { login, name: str(o?.name), team: false, suggested } : null
  }
  const suggestedRaw = obj(repo.pullRequest)?.suggestedReviewers
  const suggested = (Array.isArray(suggestedRaw) ? suggestedRaw : [])
    .map((s) => user(obj(s)?.reviewer, true))
    .filter((c): c is PrCandidate => !!c)
  const people = nodes(repo.assignableUsers)
    .map((u) => user(u, false))
    .filter((c): c is PrCandidate => !!c)
  const owner = obj(data.repositoryOwner)
  let teamList: PrCandidates["teams"] = null
  if (!teams) teamList = "no-scope"
  else if (str(owner?.__typename) === "Organization")
    teamList = nodes(owner?.teams)
      .map((t) => {
        const o = obj(t)
        const login = str(o?.combinedSlug)
        return isReviewer(login)
          ? { login, name: str(o?.name), team: true, suggested: false }
          : null
      })
      .filter((c): c is PrCandidate => !!c)
  return { suggested, people, teams: teamList }
}

/** What the picker lists for a PR: one entry per login, its review state beside it. */
export interface PickerEntry extends PrCandidate {
  status: "requested" | "reviewed" | null // reviewed: adding again re-requests
}

/** Candidates → the picker's list: suggestions, then people, then teams; the author left out. */
export function pickerEntries(c: PrCandidates, row: PrRow): PickerEntry[] {
  const seen = new Set<string>([row.author.toLowerCase()])
  const requested = new Set(row.requested.map((r) => r.toLowerCase()))
  const reviewed = new Set(row.reviewers.map((r) => r.login.toLowerCase()))
  const out: PickerEntry[] = []
  const teams = Array.isArray(c.teams) ? c.teams : []
  for (const e of [...c.suggested, ...c.people, ...teams]) {
    const k = e.login.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    const status = requested.has(k) ? "requested" : reviewed.has(k) ? "reviewed" : null
    out.push({ ...e, status })
  }
  return out
}

/** The edit's gh arguments (logins checked: nothing that isn't one reaches gh). */
export function reviewerEditArgs(req: PrReviewersRequest): string[] | null {
  const add = req.add.filter(isReviewer)
  const remove = req.remove.filter(isReviewer)
  if (add.length !== req.add.length || remove.length !== req.remove.length) return null
  if (!add.length && !remove.length) return null
  const args = ["pr", "edit", String(req.number), "--repo", req.repo]
  if (add.length) args.push("--add-reviewer", add.join(","))
  if (remove.length) args.push("--remove-reviewer", remove.join(","))
  return args
}

type Lists = Partial<Record<"mine" | "review" | "repo", PrRow[]>>

/** The lists with this PR's row in place (the same lists when it's in none). */
export function patchRow<T extends Lists>(lists: T, row: PrRow): T {
  let changed = false
  const map = (rows: PrRow[] | undefined) => {
    if (!rows?.some((r) => r.url === row.url)) return rows
    changed = true
    return rows.map((r) => (r.url === row.url ? row : r))
  }
  const out = { ...lists, mine: map(lists.mine), review: map(lists.review) }
  if (lists.repo) out.repo = map(lists.repo)
  return changed ? out : lists
}

/** The PR as a change it couldn't be asked for again after: `login` requested, or not. */
export function guessRow(row: PrRow, login: string, add: boolean): PrRow {
  const requested = row.requested.filter((r) => r !== login)
  return { ...row, requested: add ? [...requested, login] : requested }
}

/** How long after a change the PR's own row is shown over list answers (search lags). */
export const EDIT_HOLD_MS = 120_000

/** A list answer with these rows (asked for directly) in place. */
export function withRows<T extends Lists>(lists: T, rows: PrRow[]): T {
  return rows.reduce((l, r) => patchRow(l, r), lists)
}
