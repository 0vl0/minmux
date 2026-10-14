// The pull requests dialog's detail (docs/design/PR_DASHBOARD.md, step 2): one PR's body,
// conversation and review threads, parsed from one GraphQL query, plus pure helpers to show
// them. Shared with main; parsing never throws (gh's JSON is an outside format).

/** One comment or review in the conversation, oldest first. */
export interface PrEntry {
  kind: "comment" | "review"
  author: string
  body: string
  at: string
  url: string
  state?: "approved" | "changes" | "commented" | "dismissed" // a review's
}

/** A comment in a review thread. */
export interface PrThreadComment {
  author: string
  body: string
  at: string
  url: string
}

/** A review thread on one line of one file. */
export interface PrThread {
  path: string
  line: number | null // in the PR's current diff (null: outdated)
  resolved: boolean
  outdated: boolean
  hunk: string // the diff lines the thread is on (the first comment's)
  comments: PrThreadComment[]
}

/** One PR's detail. `more`: GitHub had more than the query asks for (open it there). */
export interface PrDetail {
  url: string
  updatedAt: string
  body: string
  conversation: PrEntry[]
  threads: PrThread[]
  more: boolean
}

/** A `prs:detail` request: which PR, and where gh runs (the focused pane's environment). */
export interface PrDetailRequest {
  repo: string // owner/name
  number: number
  cwd?: string
  wsl?: { distro?: string }
}

export type PrDetailResult =
  | { ok: true; detail: PrDetail }
  | { ok: false; error: "missing" | "unauthenticated" | "offline" | "failed"; message?: string }

export const THREADS = 100
export const PER_THREAD = 50
export const ENTRIES = 100

export const PR_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url updatedAt body
      reviews(first: ${ENTRIES}) { totalCount nodes { author { login } state body submittedAt url } }
      comments(first: ${ENTRIES}) { totalCount nodes { author { login } body createdAt url } }
      reviewThreads(first: ${THREADS}) {
        totalCount
        nodes {
          isResolved isOutdated path line
          comments(first: ${PER_THREAD}) { totalCount nodes { author { login } body createdAt url diffHunk } }
        }
      }
    }
  }
}`

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const nodes = (v: unknown): unknown[] => {
  const n = obj(v)?.nodes
  return Array.isArray(n) ? n : []
}
const total = (v: unknown): number => {
  const t = obj(v)?.totalCount
  return typeof t === "number" ? t : 0
}
const author = (v: unknown) => str(obj(obj(v)?.author)?.login) || "ghost" // a deleted account

const REVIEW_STATE: Record<string, PrEntry["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
}

/** `gh api graphql` output → the PR's detail (null: not an answer). */
export function parsePrDetail(out: string): PrDetail | null {
  let root: unknown
  try {
    root = JSON.parse(out)
  } catch {
    return null
  }
  const pr = obj(obj(obj(obj(root)?.data)?.repository)?.pullRequest)
  if (!pr || !str(pr.url)) return null
  const conversation: PrEntry[] = []
  for (const c of nodes(pr.comments)) {
    const o = obj(c)
    if (o)
      conversation.push({
        kind: "comment",
        author: author(o),
        body: str(o.body),
        at: str(o.createdAt),
        url: str(o.url),
      })
  }
  for (const r of nodes(pr.reviews)) {
    const o = obj(r)
    const state = REVIEW_STATE[str(o?.state)]
    // A review with no summary is only its line comments (shown in their threads), unless
    // it decided something.
    if (!o || !state || (!str(o.body).trim() && state === "commented")) continue
    conversation.push({
      kind: "review",
      author: author(o),
      body: str(o.body),
      at: str(o.submittedAt),
      url: str(o.url),
      state,
    })
  }
  conversation.sort((a, b) => a.at.localeCompare(b.at))
  const threads: PrThread[] = []
  let more =
    total(pr.comments) > ENTRIES || total(pr.reviews) > ENTRIES || total(pr.reviewThreads) > THREADS
  for (const t of nodes(pr.reviewThreads)) {
    const o = obj(t)
    if (!o || !str(o.path)) continue
    const cs = nodes(o.comments)
    if (total(o.comments) > PER_THREAD) more = true
    const comments = cs.map((c) => {
      const co = obj(c)
      return { author: author(co), body: str(co?.body), at: str(co?.createdAt), url: str(co?.url) }
    })
    threads.push({
      path: str(o.path),
      line: typeof o.line === "number" ? o.line : null,
      resolved: o.isResolved === true,
      outdated: o.isOutdated === true,
      hunk: str(obj(cs[0])?.diffHunk),
      comments,
    })
  }
  return {
    url: str(pr.url),
    updatedAt: str(pr.updatedAt),
    body: str(pr.body),
    conversation,
    threads,
    more,
  }
}

/** Threads by file (files in path order), open ones first, then by line. */
export function threadsByFile(
  threads: PrThread[],
): { path: string; threads: PrThread[]; open: number }[] {
  const by = new Map<string, PrThread[]>()
  for (const t of threads) {
    const list = by.get(t.path)
    if (list) list.push(t)
    else by.set(t.path, [t])
  }
  const done = (t: PrThread) => Number(t.resolved || t.outdated)
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, ts]) => ({
      path,
      threads: ts.sort((a, b) => done(a) - done(b) || (a.line ?? 0) - (b.line ?? 0)),
      open: ts.filter((t) => !done(t)).length,
    }))
}

/** The last `n` lines of a diff hunk (the lines the thread is on), its `@@` header dropped. */
export function hunkTail(hunk: string, n = 6): string[] {
  const lines = hunk.split(/\r?\n/).filter((l) => !l.startsWith("@@"))
  return lines.slice(-n)
}

/** A body as text and fenced code blocks, in order: shown as text, never as HTML. */
export function bodyBlocks(body: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = []
  const re = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm
  let at = 0
  for (const m of body.matchAll(re)) {
    const before = body.slice(at, m.index).trim()
    if (before) out.push({ code: false, text: before })
    out.push({ code: true, text: m[1]!.replace(/\n$/, "") })
    at = m.index + m[0].length
  }
  const rest = body.slice(at).trim()
  if (rest) out.push({ code: false, text: rest })
  return out
}

/** Text split into plain runs and http(s) links (opened in the browser, never as HTML). */
export function linkify(text: string): { text: string; url?: string }[] {
  const out: { text: string; url?: string }[] = []
  let at = 0
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"'`]+[^\s<>()"'`.,;:!?]/g)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) })
    out.push({ text: m[0], url: m[0] })
    at = m.index + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

/** When a comment was written, short. */
export function when(at: string, now = Date.now()): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return ""
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return new Date(t).toISOString().slice(0, 10)
}
