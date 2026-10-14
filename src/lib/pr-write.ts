// Writing to a PR from the pull requests dialog (docs/design/PR_DASHBOARD.md, step 6): a comment
// on its conversation, or a review (approve / request changes). Shared with main; pure.
import { nodes, obj, prErrorText, str, type PrListsError, type PrRow } from "./pr-dashboard"
import type { PrEnv } from "./pr-reviewers"

export type PrWriteAction = "comment" | "approve" | "changes"

/** A `prs:write` request: the PR, what to do, its text (sent to gh on stdin, never an arg). */
export interface PrWriteRequest extends PrEnv {
  repo: string
  number: number
  action: PrWriteAction
  body: string
}

// `row`: the PR fetched again after (null: the write went through, the fetch didn't).
// `already`: GitHub had it already (the same text by the same account, moments ago): not
// posted again.
export type PrWriteResult =
  | { ok: true; row: PrRow | null; already?: boolean }
  | { ok: false; error: PrListsError; message?: string }

export const BODY_MAX = 65_536 // GitHub's limit for a comment's body

/** A write gh may have finished on GitHub before failing: said so, never "try again". */
export const MAYBE_SENT =
  "gh didn't answer in time: it may have gone through. Check the conversation before sending again."

/** A failed write as the reply box says it: gh's own words for a refusal (not the lists'). */
export function writeErrorText(e: { error: PrListsError; message?: string }): string {
  return e.error === "failed" && e.message ? e.message : prErrorText(e)
}

/** The gh arguments for a write (null: not one gh would take: text missing or too long). */
export function writeArgs(req: PrWriteRequest): string[] | null {
  const body = req.body.trim()
  if (body.length > BODY_MAX || !Number.isInteger(req.number) || req.number < 1) return null
  const pr = [String(req.number), "--repo", req.repo]
  // (the text comes on stdin: newlines and length survive any command line)
  if (req.action === "comment") return body ? ["pr", "comment", ...pr, "--body-file", "-"] : null
  if (req.action === "changes")
    return body ? ["pr", "review", ...pr, "--request-changes", "--body-file", "-"] : null
  return ["pr", "review", ...pr, "--approve", ...(body ? ["--body-file", "-"] : [])]
}

/** What the reply box offers on a PR, acting as `login` (undefined: gh can't say who). */
export function writeActions(row: PrRow, login: string | undefined): PrWriteAction[] {
  // GitHub takes comments on closed PRs too; reviews only on open ones, never on your own.
  if (row.state === "merged" || row.state === "closed") return ["comment"]
  const mine = !!login && login.toLowerCase() === row.author.toLowerCase()
  return mine ? ["comment"] : ["comment", "approve", "changes"]
}

/** The PR's latest comments and reviews, and who's asking: is this write there already? */
export const RECENT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: 20) { nodes { author { login } body createdAt } }
      reviews(last: 20) { nodes { author { login } body state submittedAt } }
    }
  }
}`

/** How far back a write counts as the same one (a retry, a second click): not posted twice. */
export const SAME_WRITE_MS = 10 * 60_000

const norm = (s: string) => s.replace(/\r\n?/g, "\n").trimEnd()

// Guards every write against a double post: before it (a retry after an unclear failure, a
// stale view), and after a failure that may have reached GitHub (it did, or it didn't).
/** Whether the asking account already made this write since `since` (null: not an answer). */
export function alreadyPosted(out: string, req: PrWriteRequest, since: number): boolean | null {
  let root: unknown
  try {
    root = JSON.parse(out)
  } catch {
    return null
  }
  const data = obj(obj(root)?.data)
  const me = str(obj(data?.viewer)?.login).toLowerCase()
  const pr = obj(obj(data?.repository)?.pullRequest)
  if (!me || !pr) return null
  const mine = (v: unknown, at: string) => {
    const o = obj(v)
    const t = Date.parse(str(o?.[at]))
    return !!o && str(obj(o.author)?.login).toLowerCase() === me && t >= since ? o : null
  }
  const body = norm(req.body)
  if (req.action === "comment")
    return nodes(pr.comments).some((c) => {
      const o = mine(c, "createdAt")
      return !!o && norm(str(o.body)) === body
    })
  const state = req.action === "approve" ? "APPROVED" : "CHANGES_REQUESTED"
  return nodes(pr.reviews).some((r) => {
    const o = mine(r, "submittedAt")
    return !!o && str(o.state) === state && (!body || norm(str(o.body)) === body)
  })
}
