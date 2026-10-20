// A PR's branch and state from the pull requests dialog: update its branch with its base (a
// merge of the base in, as GitHub's "Update branch"), mark a draft ready for review, turn an
// open PR back into a draft, close it without merging, or reopen it. The gh commands, what each
// chip (and the close / reopen icon) offers, and when the PR's own row shows the change made.
// Shared with main; pure.
import type { PrListsError, PrRow } from "./pr-dashboard"
import type { PrEnv } from "./pr-reviewers"

export type PrBranchAction = "update" | "ready" | "draft" | "close" | "reopen"
export const BRANCH_ACTIONS: PrBranchAction[] = ["update", "ready", "draft", "close", "reopen"]

/** What this account may do to the PR's branch and state (from the checks query). */
export interface PrBranchOptions {
  canUpdateBranch: boolean // behind its base, and this account can push the merge (GitHub's)
  canEdit: boolean // its author, or write access: ready for review / back to draft
  canClose: boolean // GitHub lets this account close it (its author, or write access)
  canReopen: boolean // …or reopen it (closed, not merged)
  behind: number | null // commits on its base it doesn't have (null: GitHub didn't say)
}

/** A `prs:branch` request: the PR and what to do. */
export interface PrBranchRequest extends PrEnv {
  repo: string
  number: number
  action: PrBranchAction
}

// `row`: the PR fetched again after (null: gh said done, the fetch didn't). `pending`: gh took
// the update but GitHub hasn't merged it in yet (on its own time). `behind`: GitHub's count after.
export type PrBranchResult =
  | { ok: true; row: PrRow | null; pending?: boolean; behind?: number }
  | { ok: false; error: PrListsError; message?: string }

/** Each action as a button says it. */
export const BRANCH_WORD: Record<PrBranchAction, string> = {
  update: "Update branch",
  ready: "Ready for review",
  draft: "Convert to draft",
  close: "Close pull request",
  reopen: "Reopen pull request",
}

// What the status line says for each: asking first, while it runs, and once it's done.
export const BUSY: Record<PrBranchAction, (row: PrRow) => string> = {
  update: (r) => `Merging ${r.base} in…`,
  ready: () => "Marking it ready for review…",
  draft: () => "Converting it to a draft…",
  close: () => "Closing it…",
  reopen: () => "Reopening it…",
}
export const DONE: Record<PrBranchAction, (row: PrRow, pending: boolean) => string> = {
  update: (r, pending) =>
    pending
      ? `GitHub is merging ${r.base} in: it'll show shortly.`
      : `Branch updated: ${r.base} merged in.`,
  ready: () => "Marked ready for review.",
  draft: () => "Converted to a draft.",
  close: () => "Closed.",
  reopen: () => "Reopened.",
}
export const ASK: Record<PrBranchAction, (row: PrRow, as: string) => string> = {
  update: (r, as) => `Merge ${r.base} into ${r.head}${as}?`,
  ready: (r, as) => `Mark #${r.number} ready for review${as}? Its reviewers get notified.`,
  draft: (r, as) =>
    `Convert #${r.number} back to a draft${as}? It can't be merged until it's ready again.`,
  close: (r, as) => `Close #${r.number} without merging${as}? It can be reopened later.`,
  reopen: (r, as) => `Reopen #${r.number}${as}?`,
}

/** The checks answer's fields → the options. */
export function parseBranchOptions(pr: Record<string, unknown>): PrBranchOptions {
  const cmp = (pr.baseRef as { compare?: { behindBy?: unknown } } | null | undefined)?.compare
  const behind = cmp?.behindBy
  return {
    canUpdateBranch: pr.viewerCanUpdateBranch === true,
    canEdit: pr.viewerCanUpdate === true,
    canClose: pr.viewerCanClose === true,
    canReopen: pr.viewerCanReopen === true,
    behind: typeof behind === "number" && Number.isInteger(behind) && behind >= 0 ? behind : null,
  }
}

/** The ref the base is compared with: GitHub's own copy of the PR's head (forks included). */
export const pullHeadRef = (number: number) => `refs/pull/${number}/head`

const live = (row: PrRow) => row.state === "open" || row.state === "draft"

// (a repo that doesn't require branches up to date: its merge state never says it)
/** Behind its base by GitHub's count, though its merge state doesn't say so. */
export const behindUnsaid = (row: PrRow, o: PrBranchOptions | undefined) =>
  live(row) && row.merge !== "behind" && row.merge !== "conflicts" && (o?.behind ?? 0) > 0

/** The action a status chip offers (null: none, or not for this account). */
export function chipAction(
  part: string,
  row: PrRow,
  o: PrBranchOptions | undefined,
): PrBranchAction | null {
  if (!o) return null
  const behind = row.merge === "behind" || (o.behind ?? 0) > 0
  if (part === "behind base" && live(row) && behind && o.canUpdateBranch) return "update"
  if (part === "draft" && row.state === "draft" && o.canEdit) return "ready"
  if (part === "open" && row.state === "open" && o.canEdit) return "draft"
  return null
}

/** The close / reopen icon at the end of the status line (null: none for this account). */
export function stateAction(row: PrRow, o: PrBranchOptions | undefined): PrBranchAction | null {
  if (!o) return null
  if (live(row) && o.canClose) return "close"
  if (row.state === "closed" && o.canReopen) return "reopen"
  return null
}

/** "3 commits behind main" ("Behind main" when GitHub didn't count). */
export function behindText(behind: number | null, base: string): string {
  if (behind === null) return `Behind ${base}`
  return `${behind} commit${behind === 1 ? "" : "s"} behind ${base}`
}

// An update: GitHub's count says none behind (no count: the row's merge state, which only says
// "behind" where the repo requires branches up to date).
/** The PR shows the action made. */
export function branchDone(action: PrBranchAction, row: PrRow, behind: number | null): boolean {
  if (action === "update") return behind === null ? row.merge !== "behind" : behind === 0
  if (action === "ready") return row.state === "open"
  if (action === "close") return row.state === "closed"
  if (action === "reopen") return live(row)
  return row.state === "draft"
}

/** How far behind its base a PR is, alone (an update's check: has GitHub merged it in yet). */
export const PR_BEHIND_QUERY = `query($owner: String!, $name: String!, $number: Int!, $pull: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { baseRef { compare(headRef: $pull) { behindBy } } }
  }
}`

/** `gh api graphql` output of PR_BEHIND_QUERY → the count (null: not an answer). */
export function parseBehind(out: string): number | null {
  try {
    const pr = (JSON.parse(out) as { data?: { repository?: { pullRequest?: unknown } } }).data
      ?.repository?.pullRequest
    return pr && typeof pr === "object"
      ? parseBranchOptions(pr as Record<string, unknown>).behind
      : null
  } catch {
    return null
  }
}

/** The gh arguments for an action (null: not one gh would take). */
export function branchArgs(req: PrBranchRequest): string[] | null {
  if (!BRANCH_ACTIONS.includes(req.action) || !Number.isInteger(req.number) || req.number < 1)
    return null
  if (!/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(req.repo)) return null
  const pr = [String(req.number), "--repo", req.repo]
  // (a merge of the base in, never a rebase: a rebase rewrites a branch a pane may have out)
  if (req.action === "update") return ["pr", "update-branch", ...pr]
  if (req.action === "close" || req.action === "reopen") return ["pr", req.action, ...pr]
  return ["pr", "ready", ...pr, ...(req.action === "draft" ? ["--undo"] : [])]
}
