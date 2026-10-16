// A PR's branch and draft state from the pull requests dialog: update its branch with its base
// (a merge of the base in, as GitHub's "Update branch"), mark a draft ready for review, or turn
// an open PR back into a draft. The gh commands, what each chip offers, and when the PR's own
// row shows the change made. Shared with main; pure.
import type { PrListsError, PrRow } from "./pr-dashboard"
import type { PrEnv } from "./pr-reviewers"

export type PrBranchAction = "update" | "ready" | "draft"
export const BRANCH_ACTIONS: PrBranchAction[] = ["update", "ready", "draft"]

/** What this account may do to the PR's branch and state (from the checks query). */
export interface PrBranchOptions {
  canUpdateBranch: boolean // behind its base, and this account can push the merge (GitHub's)
  canEdit: boolean // its author, or write access: ready for review / back to draft
  behind: number | null // commits on its base it doesn't have (null: GitHub didn't say)
}

/** A `prs:branch` request: the PR and what to do. */
export interface PrBranchRequest extends PrEnv {
  repo: string
  number: number
  action: PrBranchAction
}

// `row`: the PR fetched again after (null: gh said done, the fetch didn't). `pending`: gh took
// the update but the row doesn't show it yet (GitHub merges the base in on its own time).
export type PrBranchResult =
  | { ok: true; row: PrRow | null; pending?: boolean }
  | { ok: false; error: PrListsError; message?: string }

/** Each action as a button says it. */
export const BRANCH_WORD: Record<PrBranchAction, string> = {
  update: "Update branch",
  ready: "Ready for review",
  draft: "Convert to draft",
}

/** The checks answer's fields → the options. */
export function parseBranchOptions(pr: Record<string, unknown>): PrBranchOptions {
  const cmp = (pr.baseRef as { compare?: { behindBy?: unknown } } | null | undefined)?.compare
  const behind = cmp?.behindBy
  return {
    canUpdateBranch: pr.viewerCanUpdateBranch === true,
    canEdit: pr.viewerCanUpdate === true,
    behind: typeof behind === "number" && Number.isInteger(behind) && behind >= 0 ? behind : null,
  }
}

/** The ref the base is compared with: GitHub's own copy of the PR's head (forks included). */
export const pullHeadRef = (number: number) => `refs/pull/${number}/head`

/** The action a status chip offers (null: none, or not for this account). */
export function chipAction(
  part: string,
  row: PrRow,
  o: PrBranchOptions | undefined,
): PrBranchAction | null {
  if (!o) return null
  if (part === "behind base" && row.merge === "behind" && o.canUpdateBranch) return "update"
  if (part === "draft" && row.state === "draft" && o.canEdit) return "ready"
  if (part === "open" && row.state === "open" && o.canEdit) return "draft"
  return null
}

/** "3 commits behind main" (just "behind main" when GitHub didn't count). */
export function behindText(behind: number | null, base: string): string {
  if (!behind) return `Behind ${base}`
  return `${behind} commit${behind === 1 ? "" : "s"} behind ${base}`
}

/** The PR's row shows the action made. */
export function branchDone(action: PrBranchAction, row: PrRow): boolean {
  if (action === "update") return row.merge !== "behind"
  if (action === "ready") return row.state === "open"
  return row.state === "draft"
}

/** The gh arguments for an action (null: not one gh would take). */
export function branchArgs(req: PrBranchRequest): string[] | null {
  if (!BRANCH_ACTIONS.includes(req.action) || !Number.isInteger(req.number) || req.number < 1)
    return null
  if (!/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(req.repo)) return null
  const pr = [String(req.number), "--repo", req.repo]
  // (a merge of the base in, never a rebase: a rebase rewrites a branch a pane may have out)
  if (req.action === "update") return ["pr", "update-branch", ...pr]
  return ["pr", "ready", ...pr, ...(req.action === "draft" ? ["--undo"] : [])]
}
