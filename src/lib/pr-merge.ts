// Merging a PR from the pull requests dialog: the three ways GitHub merges (a merge commit,
// squash, rebase), which ones the repo allows, and the gh command. Shared with main; pure.
import type { PrListsError, PrRow } from "./pr-dashboard"
import type { PrEnv } from "./pr-reviewers"

export type PrMergeMethod = "merge" | "squash" | "rebase"
export const MERGE_METHODS: PrMergeMethod[] = ["merge", "squash", "rebase"]

/** What the merge box offers: the repo's allowed ways, and whether this account may merge. */
export interface PrMergeOptions {
  methods: PrMergeMethod[] // the repo's allowed ways, in GitHub's order
  preferred: PrMergeMethod | null // the way this account merged last (GitHub remembers it)
  canMerge: boolean // write access or more (GitHub still checks its rules)
  head: string // the PR's head commit (full): merged only if it's still that one
}

/** A `prs:merge` request: the PR, how, and the head commit the user saw. */
export interface PrMergeRequest extends PrEnv {
  repo: string
  number: number
  method: PrMergeMethod
  head?: string
}

// `row`: the PR fetched again after (null: it merged, the fetch didn't).
export type PrMergeResult =
  { ok: true; row: PrRow | null } | { ok: false; error: PrListsError; message?: string }

/** Each way, as GitHub words it. */
export const MERGE_WORD: Record<PrMergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
}

const METHOD: Record<string, PrMergeMethod> = { MERGE: "merge", SQUASH: "squash", REBASE: "rebase" }
const WRITERS = new Set(["ADMIN", "MAINTAIN", "WRITE"])

/** A repository's merge settings (GraphQL) → the options (null: not an answer). */
export function parseMergeOptions(repo: Record<string, unknown> | null, head: string) {
  if (!repo) return null
  const allowed: Record<PrMergeMethod, unknown> = {
    merge: repo.mergeCommitAllowed,
    squash: repo.squashMergeAllowed,
    rebase: repo.rebaseMergeAllowed,
  }
  const methods = MERGE_METHODS.filter((m) => allowed[m] === true)
  const preferred = METHOD[String(repo.viewerDefaultMergeMethod)] ?? null
  return {
    methods,
    preferred: preferred && methods.includes(preferred) ? preferred : null,
    canMerge: WRITERS.has(String(repo.viewerPermission)),
    head: /^[0-9a-f]{40}$/.test(head) ? head : "",
  } satisfies PrMergeOptions
}

/** The way the box starts on: the one picked last for this repo, GitHub's, else the first. */
export function startMethod(o: PrMergeOptions, saved: string | null): PrMergeMethod | null {
  const s = MERGE_METHODS.find((m) => m === saved)
  if (s && o.methods.includes(s)) return s
  return o.preferred ?? o.methods[0] ?? null
}

/** Why the PR can't be merged from here (null: it can be tried; GitHub has the last word). */
export function mergeBlocked(row: PrRow, o: PrMergeOptions): string | null {
  if (row.state === "merged" || row.state === "closed") return `It's ${row.state}.`
  if (row.state === "draft") return "It's a draft: mark it ready for review first."
  if (row.merge === "conflicts") return "It has conflicts with its base: resolve them first."
  if (!o.canMerge) return "This account can't merge in this repo."
  if (!o.methods.length) return "The repo allows no way to merge."
  return null
}

/** The gh arguments for a merge (null: not one gh would take). */
export function mergeArgs(req: PrMergeRequest): string[] | null {
  if (!MERGE_METHODS.includes(req.method) || !Number.isInteger(req.number) || req.number < 1)
    return null
  if (!/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(req.repo)) return null
  const args = ["pr", "merge", String(req.number), "--repo", req.repo, `--${req.method}`]
  // (a push since the user looked: GitHub refuses, nothing they didn't see goes in)
  if (req.head && /^[0-9a-f]{40}$/.test(req.head)) args.push("--match-head-commit", req.head)
  return args
}
