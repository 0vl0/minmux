import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowClockwise,
  ArrowSquareOut,
  GitMerge,
  GitPullRequest,
  TerminalWindow,
  X,
} from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { wslContext } from "../lib/wsl"
import { paneOfGitKey } from "../lib/agent-dirs"
import { displaySessionTitle } from "../lib/session-label"
import {
  nextRefreshMs,
  panesByPr,
  PR_TABS,
  statusParts,
  tabFor,
  type PrLists,
  type PrListsError,
  type PrListsRequest,
  type PrListsResult,
  type PrRow,
  type PrTab,
} from "../lib/pr-dashboard"
import { prStateUi } from "../lib/pane-git"
import { refocusActiveTerminal } from "./refocus-terminal"

// The last answer, kept across opens: shown at once (with its age) while a refresh runs.
let last: { lists: PrLists; at: number; closed: boolean } | null = null
const TAB_KEY = "minmux.prDialog.tab"

const readTab = (): PrTab => {
  try {
    const t = localStorage.getItem(TAB_KEY) as PrTab | null
    return t && PR_TABS.includes(t) ? t : "mine"
  } catch {
    return "mine"
  }
}

const ERRORS: Record<PrListsError, string> = {
  missing:
    "GitHub CLI (gh) isn't installed. Install it from cli.github.com, then run gh auth login.",
  unauthenticated: "gh isn't logged in. Run `gh auth login` in a terminal.",
  offline: "Can't reach GitHub.",
  failed: "gh couldn't load pull requests.",
}

const keyOf = (r: PrListsRequest) =>
  JSON.stringify([r.cwd ?? "", r.wsl ? (r.wsl.distro ?? "") : null, r.closed])

const ago = (ms: number) =>
  ms < 10_000
    ? "just now"
    : ms < 60_000
      ? `${Math.round(ms / 1000)} s ago`
      : `${Math.round(ms / 60_000)} min ago`

/** The focused pane's checkout: the repo tab's repo, and gh's environment (WSL or host). */
function useFocusedRequest(closed: boolean): PrListsRequest {
  const sid = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId)
  const session = useStore((s) => (sid ? s.sessions[sid] : undefined))
  const root = useStore((s) => (sid ? s.paneGit[sid]?.root : undefined))
  return useMemo(() => {
    if (!session || session.remote) return { closed } // an ssh pane has no local checkout
    const wsl = wslContext(session.command, session.args)
    const cwd = root ?? session.cwd
    return cwd ? { cwd, wsl, closed } : { wsl, closed }
  }, [session, root, closed])
}

/** The pull requests dialog: mine, review requested, the focused pane's repo. */
export function PrDialog() {
  const [closed, setClosed] = useState(last?.closed ?? false)
  const req = useFocusedRequest(closed)
  const [lists, setLists] = useState<PrLists | null>(last?.closed === closed ? last.lists : null)
  const [at, setAt] = useState(last?.closed === closed ? last.at : 0)
  const [error, setError] = useState<{ error: PrListsError; message?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTabState] = useState<PrTab>(readTab)
  const [sel, setSel] = useState(0)
  const [now, setNow] = useState(Date.now())
  const failures = useRef(0)
  const busy = useRef(false)
  const again = useRef(false)
  const halted = useRef(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  const reqRef = useRef(req)
  reqRef.current = req
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    useStore.getState().setPrDialogOpen(false)
    refocusActiveTerminal()
  }, [])

  // Not installed / logged out: no more automatic tries (the button still asks).
  const apply = useCallback((res: PrListsResult | null, r: PrListsRequest) => {
    if (!res || !res.ok) {
      failures.current++
      const err = res && !res.ok ? res : { error: "failed" as const, message: undefined }
      halted.current = err.error === "missing" || err.error === "unauthenticated"
      setError({ error: err.error, message: err.message })
      return
    }
    failures.current = 0
    halted.current = false
    setError(null)
    setLists(res.lists)
    setAt(Date.now())
    last = { lists: res.lists, at: Date.now(), closed: r.closed }
  }, [])

  // One at a time. Asked again meanwhile (the repo changed, "closed" toggled): once more
  // right after; an answer for a request that's no longer the one shown is dropped.
  const refresh = useCallback(async (): Promise<void> => {
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    setLoading(true)
    const r = reqRef.current
    const res = await ipc.prLists(r).catch(() => null)
    busy.current = false
    if (!alive.current) return
    setLoading(false)
    const stale = keyOf(reqRef.current) !== keyOf(r)
    if (!stale) apply(res, r)
    if (stale || again.current) {
      again.current = false
      return refresh()
    }
  }, [apply])

  // On open, and when the repo or "closed" changes: at once; then by nextRefreshMs while open
  // (nothing runs while it's closed, nor while the window is hidden).
  const reqKey = keyOf(req)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop = false
    const loop = async () => {
      if (document.visibilityState !== "hidden" && !halted.current) await refresh()
      if (stop) return
      timer = setTimeout(() => void loop(), nextRefreshMs(last?.lists ?? null, failures.current))
    }
    void loop()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [reqKey, refresh])

  // The "updated … ago" label.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [])

  const tabs: PrTab[] = lists && !lists.repo ? ["mine", "review"] : PR_TABS
  const shownTab = tabs.includes(tab) ? tab : "mine"
  const rows = (lists?.[shownTab] ?? []) as PrRow[]
  const row = rows[Math.min(sel, rows.length - 1)]
  // The list shrank under the selection (a refresh, "closed" off): it stays on the last row.
  useEffect(() => {
    if (sel > 0 && sel >= rows.length) setSel(Math.max(rows.length - 1, 0))
  }, [sel, rows.length])

  const setTab = (t: PrTab) => {
    setTabState(t)
    setSel(0)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // per-viewer convenience only
    }
  }

  const paneGit = useStore((s) => s.paneGit)
  const sessions = useStore((s) => s.sessions)
  const home = useStore((s) => s.home)
  const panes = useMemo(
    () => panesByPr(paneGit, (k) => !!sessions[paneOfGitKey(k)], paneOfGitKey),
    [paneGit, sessions],
  )
  const goToPane = (id: string) => {
    useStore.getState().setPrDialogOpen(false)
    useStore.getState().focusSession(id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key
    if (k === "Escape") {
      e.preventDefault()
      return close()
    }
    // A focused button or checkbox keeps its own keys (Enter, Space…).
    if ((e.target as HTMLElement).closest("button, input, select, textarea, a")) return
    const t = tabFor(k, shownTab, tabs)
    if (t) {
      e.preventDefault()
      return setTab(t)
    }
    if (k === "ArrowDown" || k === "j") {
      e.preventDefault()
      setSel((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)))
    } else if (k === "ArrowUp" || k === "k") {
      e.preventDefault()
      setSel((i) => Math.max(i - 1, 0))
    } else if ((k === "o" || k === "Enter") && row) {
      e.preventDefault()
      ipc.openExternal(row.url)
    } else if (k === "r") {
      e.preventDefault()
      void refresh()
    }
  }

  // Keyboard focus lives in the dialog while it's open; the selected row stays in view.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => rootRef.current?.focus(), [])
  useEffect(() => {
    listRef.current?.querySelector(".pr-row.sel")?.scrollIntoView?.({ block: "nearest" })
  }, [sel, shownTab])

  const label = (t: PrTab) =>
    t === "mine" ? "Mine" : t === "review" ? "Review requested" : (lists?.repoName ?? "Repo")

  return (
    <div className="settings-overlay" onMouseDown={close}>
      <div
        ref={rootRef}
        className="pr-dialog"
        role="dialog"
        aria-label="Pull requests"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pr-header">
          <GitPullRequest size={16} />
          <h2>Pull requests</h2>
          <span className="pr-age">
            {loading ? "Refreshing…" : at ? `Updated ${ago(now - at)}` : ""}
          </span>
          <button
            className="iconbtn"
            title="Refresh (r)"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <ArrowClockwise size={15} />
          </button>
          <button className="iconbtn" title="Close (Esc)" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="pr-tabs" role="tablist">
          {tabs.map((t, i) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === shownTab}
              className={`pr-tab${t === shownTab ? " on" : ""}`}
              title={`${label(t)} (${i + 1})`}
              onClick={() => setTab(t)}
            >
              {label(t)}
              {lists && <span className="pr-count">{(lists[t] ?? []).length}</span>}
            </button>
          ))}
          <label className="pr-closed">
            <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
            Include closed (14 days)
          </label>
        </div>
        {error && (
          <div className={`pr-error${lists ? " stale" : ""}`}>
            {ERRORS[error.error]}
            {error.message ? ` ${error.message}` : ""}
            {lists ? " Showing the last answer." : ""}
          </div>
        )}
        {lists?.warning && !error && (
          <div className="pr-error stale">Some pull requests couldn't load: {lists.warning}</div>
        )}
        <div className="pr-body">
          <div className="pr-list" ref={listRef} role="listbox" aria-label={label(shownTab)}>
            {lists && rows.length === 0 && (
              <div className="pr-empty">
                {shownTab === "review"
                  ? "No pull requests wait for your review."
                  : "No pull requests."}
              </div>
            )}
            {!lists && !error && <div className="pr-empty">Loading…</div>}
            {rows.map((r, i) => (
              <PrListRow
                key={r.url}
                row={r}
                selected={r === row}
                showRepo={shownTab !== "repo"}
                panes={panes.get(r.url) ?? []}
                onSelect={() => setSel(i)}
              />
            ))}
          </div>
          <div className="pr-detail">
            {row ? (
              <PrSummary
                row={row}
                panes={(panes.get(row.url) ?? []).map((id) => ({
                  id,
                  title: displaySessionTitle(sessions[id], home),
                }))}
                onPane={goToPane}
              />
            ) : (
              <div className="pr-empty">Select a pull request.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StateIcon({ row }: { row: PrRow }) {
  const ui = prStateUi(row.state)
  const Icon = row.state === "merged" ? GitMerge : GitPullRequest
  return (
    <span className="pr-state" style={{ color: `var(--${ui.color})` }} title={ui.word}>
      <Icon size={14} weight={row.state === "draft" ? "regular" : "bold"} />
    </span>
  )
}

function PrListRow(props: {
  row: PrRow
  selected: boolean
  showRepo: boolean
  panes: string[]
  onSelect: () => void
}) {
  const { row, selected, showRepo, panes, onSelect } = props
  return (
    <div
      className={`pr-row${selected ? " sel" : ""}`}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={() => ipc.openExternal(row.url)}
    >
      <StateIcon row={row} />
      <div className="pr-row-main">
        <div className="pr-row-title">
          <span className="pr-num">#{row.number}</span> {row.title}
        </div>
        <div className="pr-row-status">
          {showRepo && <span className="pr-repo">{row.repo}</span>}
          {statusParts(row).map((p) => (
            <span key={p} className={`pr-chip ${chipTone(p)}`}>
              {p}
            </span>
          ))}
          {panes.length > 0 && (
            <span className="pr-chip pane" title="Checked out in a terminal">
              <TerminalWindow size={11} /> {panes.length}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function chipTone(part: string): string {
  if (part === "approved" || part === "CI passed") return "good"
  if (/changes requested|conflicts|failing|closed/.test(part)) return "bad"
  if (/behind|running|review/.test(part)) return "warn"
  return ""
}

function PrSummary(props: {
  row: PrRow
  panes: { id: string; title: string }[]
  onPane: (id: string) => void
}) {
  const { row, panes, onPane } = props
  return (
    <div className="pr-summary">
      <div className="pr-summary-title">
        <StateIcon row={row} />
        <h3>
          {row.title} <span className="pr-num">#{row.number}</span>
        </h3>
      </div>
      <div className="pr-meta">
        {row.repo} · {row.author} · <code>{row.head}</code> → <code>{row.base}</code> ·{" "}
        <span className="pr-add">+{row.additions}</span>{" "}
        <span className="pr-del">−{row.deletions}</span>
      </div>
      <div className="pr-row-status">
        {statusParts(row).map((p) => (
          <span key={p} className={`pr-chip ${chipTone(p)}`}>
            {p}
          </span>
        ))}
      </div>
      <h4>Reviewers</h4>
      {row.reviewers.length === 0 && row.requested.length === 0 ? (
        <div className="pr-faint">No reviewers yet.</div>
      ) : (
        <ul className="pr-reviewers">
          {row.reviewers.map((r) => (
            <li key={r.login}>
              {r.login}{" "}
              <span
                className={`pr-chip ${r.state === "approved" ? "good" : r.state === "changes" ? "bad" : ""}`}
              >
                {REVIEWER_WORD[r.state]}
              </span>
            </li>
          ))}
          {row.requested
            .filter((login) => !row.reviewers.some((r) => r.login === login))
            .map((login) => (
              <li key={login}>
                {login} <span className="pr-chip warn">requested</span>
              </li>
            ))}
        </ul>
      )}
      {panes.length > 0 && (
        <>
          <h4>Checked out in</h4>
          <div className="pr-panes">
            {panes.map((p) => (
              <button
                key={p.id}
                className="pr-pane"
                title="Go to this terminal"
                onClick={() => onPane(p.id)}
              >
                <TerminalWindow size={13} /> {p.title}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="pr-actions">
        <button
          className="pr-open"
          title="Open on GitHub (o)"
          onClick={() => ipc.openExternal(row.url)}
        >
          <ArrowSquareOut size={14} /> Open on GitHub
        </button>
      </div>
    </div>
  )
}

const REVIEWER_WORD: Record<PrRow["reviewers"][number]["state"], string> = {
  approved: "approved",
  changes: "changes requested",
  commented: "commented",
  dismissed: "dismissed",
}
