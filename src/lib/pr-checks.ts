// A PR's checks and commits for the pull requests dialog: the latest commit's checks (CI runs
// and commit statuses, each with its log), and the PR's commits with each one's overall state.
// One light query, asked again while checks run. Shared with main; parsing never throws.
import { nodes, obj, str, type PrListsError } from "./pr-dashboard"

export type CheckState = "passed" | "failed" | "running" | "skipped" | "neutral"

/** One check on the latest commit. */
export interface PrCheck {
  name: string
  workflow: string // the CI workflow it's part of ("" for a commit status or an app's check)
  state: CheckState
  url: string // its log / details
}

/** One commit of the PR, newest last. */
export interface PrCommit {
  oid: string // abbreviated
  headline: string
  author: string
  at: string
  url: string
  state: CheckState | null // its checks together (null: none)
}

/** A PR's checks (latest commit) and commits. */
export interface PrChecks {
  updatedAt: string
  state: CheckState | null // the latest commit's checks together
  checks: PrCheck[]
  commits: PrCommit[]
  moreCommits: number // older ones not listed
}

export interface PrChecksRequest {
  repo: string
  number: number
  cwd?: string
  wsl?: { distro?: string }
  account?: string
}

export type PrChecksResult =
  { ok: true; checks: PrChecks } | { ok: false; error: PrListsError; message?: string }

export const COMMITS = 20
export const CHECKS = 100

export const PR_CHECKS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      updatedAt
      latest: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: ${CHECKS}) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }
      commits(last: ${COMMITS}) { totalCount nodes { commit {
        abbreviatedOid messageHeadline committedDate url author { name user { login } } statusCheckRollup { state }
      } } }
    }
  }
}`

// A check run: its status while running, its conclusion when done.
const RUN_DONE: Record<string, CheckState> = {
  SUCCESS: "passed",
  FAILURE: "failed",
  TIMED_OUT: "failed",
  STARTUP_FAILURE: "failed",
  ACTION_REQUIRED: "failed",
  CANCELLED: "neutral",
  SKIPPED: "skipped",
  NEUTRAL: "neutral",
  STALE: "neutral",
}
// A commit status, and a rollup (the commit's checks together).
const STATE: Record<string, CheckState> = {
  SUCCESS: "passed",
  FAILURE: "failed",
  ERROR: "failed",
  PENDING: "running",
  EXPECTED: "running",
}

/** One rollup context (a check run or a commit status) → a check (null: not one). */
function parseCheck(v: unknown): PrCheck | null {
  const o = obj(v)
  if (!o) return null
  if (str(o.__typename) === "CheckRun") {
    const done = str(o.status) === "COMPLETED"
    return {
      name: str(o.name),
      workflow: str(obj(obj(obj(obj(o.checkSuite)?.workflowRun)?.workflow))?.name),
      state: done ? (RUN_DONE[str(o.conclusion)] ?? "neutral") : "running",
      url: str(o.detailsUrl),
    }
  }
  if (str(o.__typename) === "StatusContext")
    return {
      name: str(o.context),
      workflow: "",
      state: STATE[str(o.state)] ?? "neutral",
      url: str(o.targetUrl),
    }
  return null
}

const ORDER: Record<CheckState, number> = {
  failed: 0,
  running: 1,
  passed: 2,
  neutral: 3,
  skipped: 4,
}

/** `gh api graphql` output → the PR's checks and commits (null: not an answer). */
export function parsePrChecks(out: string): PrChecks | null {
  let root: unknown
  try {
    root = JSON.parse(out)
  } catch {
    return null
  }
  const pr = obj(obj(obj(obj(root)?.data)?.repository)?.pullRequest)
  if (!pr) return null
  const rollup = obj(obj(obj(nodes(pr.latest)[0])?.commit)?.statusCheckRollup)
  const checks = nodes(obj(rollup?.contexts))
    .map(parseCheck)
    .filter((c): c is PrCheck => !!c && !!c.name)
    // failures first, then running, then the rest; by name within
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name))
  const commits = nodes(pr.commits).flatMap((n) => {
    const c = obj(obj(n)?.commit)
    if (!c) return []
    const author = obj(c.author)
    return [
      {
        oid: str(c.abbreviatedOid),
        headline: str(c.messageHeadline),
        author: str(obj(author?.user)?.login) || str(author?.name),
        at: str(c.committedDate),
        url: str(c.url),
        state: STATE[str(obj(c.statusCheckRollup)?.state)] ?? null,
      },
    ]
  })
  const total =
    typeof obj(pr.commits)?.totalCount === "number"
      ? (obj(pr.commits)!.totalCount as number)
      : commits.length
  return {
    updatedAt: str(pr.updatedAt),
    state: STATE[str(rollup?.state)] ?? null,
    checks,
    commits,
    moreCommits: Math.max(0, total - commits.length),
  }
}

/** Whether the checks are still running: the dialog asks again soon. */
export const checksRunning = (c: PrChecks | undefined) =>
  !!c && (c.state === "running" || c.checks.some((x) => x.state === "running"))
