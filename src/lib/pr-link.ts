// GitHub pull request links (a terminal's, the sidebar's) open in the pull requests dialog
// instead of the browser. Pure.
import type { PrRef } from "./pr-detail"
import { prErrorText, type PrListsError, type PrRow } from "./pr-dashboard"

// github.com/<owner>/<name>/pull/<n>, with any tab, anchor or query after it
const PR_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][\w-]*)\/([\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/i

/** The PR a link points at (null: not a GitHub pull request link). */
export function prRefOfUrl(url: string): PrRef | null {
  const m = PR_URL.exec(url.trim())
  if (!m) return null
  const number = Number(m[3])
  if (!Number.isSafeInteger(number) || number < 1) return null
  return { repo: `${m[1]}/${m[2]!.replace(/\.git$/i, "")}`, number }
}

/** A `prs:find` request: the PR a link named, and where gh runs (the focused pane's). */
export interface PrFindRequest extends PrRef {
  cwd?: string
  wsl?: { distro?: string }
}

// `notFound`: no account gh has can see it (or there's no such PR); `tried`: those accounts.
export type PrFindResult =
  | { ok: true; row: PrRow }
  | { ok: false; error: PrListsError; message?: string; notFound?: boolean; tried?: string[] }

/** What the dialog says when a link's PR can't be shown. */
export function findErrorText(res: Exclude<PrFindResult, { ok: true }>, pr: PrRef): string {
  if (!res.notFound) return prErrorText(res)
  const who = res.tried?.length
    ? res.tried.length === 1
      ? `gh's account @${res.tried[0]} can't`
      : `None of gh's accounts (${res.tried.map((l) => `@${l}`).join(", ")}) can`
    : "gh can't"
  return `${who} see ${pr.repo}#${pr.number}. Check that the link is right, or log in to an account that can see it: run gh auth login in a terminal.`
}
