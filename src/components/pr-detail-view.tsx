import { useEffect, useState } from "react"
import { ArrowSquareOut, PencilSimple } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import {
  bodyBlocks,
  hunkTail,
  linkify,
  threadsByFile,
  when,
  type PrDetail,
  type PrDetailResult,
  type PrEntry,
  type PrThread,
} from "../lib/pr-detail"
import type { PrRow } from "../lib/pr-dashboard"

// Details already fetched, by PR url: shown at once while unchanged (`updatedAt`), kept for the
// app's life but bounded.
const cache = new Map<string, PrDetail>()
const CACHE_MAX = 50
const DEBOUNCE_MS = 250 // j/k through the list: only the PR it stops on is asked for

/** Text with its links clickable; markdown shown as text, never as HTML. */
function Text({ text }: { text: string }) {
  return (
    <>
      {linkify(text).map((p, i) =>
        p.url ? (
          <a
            key={i}
            href={p.url}
            onClick={(e) => {
              e.preventDefault()
              ipc.openExternal(p.url!)
            }}
          >
            {p.text}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

function Body({ body }: { body: string }) {
  const blocks = bodyBlocks(body)
  if (!blocks.length) return <div className="pr-faint">No description.</div>
  return (
    <div className="pr-md">
      {blocks.map((b, i) =>
        b.code ? (
          <pre key={i} className="pr-code">
            {b.text}
          </pre>
        ) : (
          <p key={i}>
            <Text text={b.text} />
          </p>
        ),
      )}
    </div>
  )
}

const STATE_WORD: Record<NonNullable<PrEntry["state"]>, [string, string]> = {
  approved: ["approved", "good"],
  changes: ["requested changes", "bad"],
  commented: ["reviewed", ""],
  dismissed: ["review dismissed", ""],
}

function Entry({ e }: { e: PrEntry }) {
  const state = e.state ? STATE_WORD[e.state] : undefined
  return (
    <div className="pr-comment">
      <div className="pr-comment-head">
        <b>{e.author}</b>
        {state && <span className={`pr-chip ${state[1]}`}>{state[0]}</span>}
        <span className="pr-faint">{when(e.at)}</span>
        {e.url && (
          <button
            className="pr-link"
            title="Open on GitHub"
            onClick={() => ipc.openExternal(e.url)}
          >
            <ArrowSquareOut size={12} />
          </button>
        )}
      </div>
      {e.body.trim() && <Body body={e.body} />}
    </div>
  )
}

function Hunk({ hunk }: { hunk: string }) {
  const lines = hunkTail(hunk)
  if (!lines.length) return null
  return (
    <pre className="pr-hunk">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
          {l || " "}
        </div>
      ))}
    </pre>
  )
}

function Thread({ t, onOpen }: { t: PrThread; onOpen?: () => void }) {
  const done = t.resolved || t.outdated
  return (
    <details className={`pr-thread${done ? " done" : ""}`} open={!done}>
      <summary>
        <span>{t.line !== null ? `line ${t.line}` : "outdated"}</span>
        {t.resolved && <span className="pr-chip good">resolved</span>}
        {t.outdated && !t.resolved && <span className="pr-chip">outdated</span>}
        <span className="pr-faint">
          {t.comments.length} comment{t.comments.length === 1 ? "" : "s"}
        </span>
        {onOpen && t.line !== null && (
          <button
            className="pr-link"
            title="Open in editor at this line"
            onClick={(e) => {
              e.preventDefault()
              onOpen()
            }}
          >
            <PencilSimple size={12} />
          </button>
        )}
      </summary>
      <Hunk hunk={t.hunk} />
      {t.comments.map((c, i) => (
        <Entry key={c.url || i} e={{ kind: "comment", ...c }} />
      ))}
    </details>
  )
}

/** The selected PR's description, conversation and review threads (fetched on selection). */
export function PrDetailView(props: {
  row: PrRow
  env: { cwd?: string; wsl?: { distro?: string } }
  checkout?: string // this PR's repo checked out on the host: threads open in the editor
}) {
  const { row, env, checkout } = props
  const fresh = (d: PrDetail | undefined) => (d && d.updatedAt === row.updatedAt ? d : undefined)
  const [detail, setDetail] = useState<PrDetail | undefined>(() => cache.get(row.url))
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<string | null>(null)

  useEffect(() => {
    const hit = cache.get(row.url)
    setDetail(hit)
    setError(null)
    setMissing(null)
    if (fresh(hit)) return
    let live = true
    const timer = setTimeout(() => {
      void ipc
        .prDetail({ repo: row.repo, number: row.number, cwd: env.cwd, wsl: env.wsl })
        .catch((): PrDetailResult => ({ ok: false, error: "failed" }))
        .then((res) => {
          if (!live) return
          if (!res.ok) return setError(res.message ?? "Couldn't load the comments.")
          cache.delete(row.url)
          cache.set(row.url, res.detail)
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
          setDetail(res.detail)
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // env is the focused pane's: a new one doesn't change the PR's comments
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.url, row.updatedAt])

  const open = (path: string, line: number | null) => {
    if (!checkout) return
    void ipc.pathExists(checkout, path).then((ok) => {
      if (ok) ipc.openFile(checkout, path, line ?? undefined)
      else setMissing(path)
    })
  }

  if (!detail) return <div className="pr-faint pr-loading">{error ?? "Loading comments…"}</div>
  const files = threadsByFile(detail.threads)
  const openThreads = files.reduce((n, f) => n + f.open, 0)
  return (
    <div className="pr-detail-body">
      {error && <div className="pr-error stale">{error} Showing the last answer.</div>}
      <h4>Description</h4>
      <Body body={detail.body} />
      {files.length > 0 && (
        <>
          <h4>
            Review threads ({detail.threads.length}
            {openThreads ? `, ${openThreads} open` : ""})
          </h4>
          {missing && <div className="pr-faint">{missing} isn't in this checkout.</div>}
          {files.map((f) => (
            <div key={f.path} className="pr-file">
              <div className="pr-file-path">
                <code>{f.path}</code>
              </div>
              {f.threads.map((t, i) => (
                <Thread
                  key={t.comments[0]?.url || i}
                  t={t}
                  onOpen={checkout ? () => open(f.path, t.line) : undefined}
                />
              ))}
            </div>
          ))}
        </>
      )}
      <h4>Conversation ({detail.conversation.length})</h4>
      {detail.conversation.length === 0 ? (
        <div className="pr-faint">No comments yet.</div>
      ) : (
        detail.conversation.map((e, i) => <Entry key={e.url || i} e={e} />)
      )}
      {detail.more && (
        <div className="pr-faint">
          Some comments aren't shown here.{" "}
          <a
            href={row.url}
            onClick={(e) => {
              e.preventDefault()
              ipc.openExternal(row.url)
            }}
          >
            See them all on GitHub
          </a>
        </div>
      )}
    </div>
  )
}
