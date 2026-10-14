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
  prErrorText,
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
import { PrDetailView } from "./pr-detail-view"
import { PrReviewers } from "./pr-reviewers"
import {
  editedFrom,
  guessRow,
  patchRow,
  withEdits,
  type EditedReviewers,
  type PrReviewersResult,
} from "../lib/pr-reviewers"

// The last answer, kept across opens: shown at once (with its age) while a refresh runs.
let last: { lists: PrLists; at: number; closed: boolean; key: string } | null = null
// PRs changed from the dialog, by url: list answers that don't show the change yet keep it.
// Bounded. `edits`: each PR's change in flight (one at a time) or its error, kept here so a
// view that remounts (moved away and back, the dialog reopened) still shows it.
const edited = new Map<string, EditedReviewers>()
const edits = new Map<string, { busy: string | null; error: string | null }>()
const findRow = (lists: PrLists | null, url: string) =>
  [...(lists?.mine ?? []), ...(lists?.review ?? []), ...(lists?.repo ?? [])].find(
    (r) => r.url === url,
  )
const TAB_KEY = "minmux.prDialog.tab"
const TEXT_FIELD =
  "textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])"

const readTab = (): PrTab => {
  try {
    const t = localStorage.getItem(TAB_KEY) as PrTab | null
    return t && PR_TABS.includes(t) ? t : "mine"
  } catch {
    return "mine"
  }
}

const keyOf = (r: PrListsRequest) =>
  JSON.stringify([r.cwd ?? "", r.wsl ? (r.wsl.distro ?? "") : null, r.closed])

const ago = (ms: number) =>
  ms < 10_000
    ? "just now"
    : ms < 60_000
      ? `${Math.round(ms / 1000)} s ago`
      : `${Math.round(ms / 60_000)} min ago`

/** The focused pane's checkout root and branch, once its git lookup answered. */
function useFocusedCheckout(): { root?: string; branch?: string } {
  const sid = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId)
  const root = useStore((s) => (sid ? s.paneGit[sid]?.root : undefined))
  const branch = useStore((s) => (sid ? (s.paneGit[sid]?.branch ?? undefined) : undefined))
  return useMemo(() => ({ root, branch }), [root, branch])
}

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
  const checkout = useFocusedCheckout()
  // Only for the same request (the same repo and "closed"): another pane's repo isn't shown.
  const mine = last?.key === keyOf(req) ? last : null
  const [lists, setLists] = useState<PrLists | null>(mine?.lists ?? null)
  const [at, setAt] = useState(mine?.at ?? 0)
  const [error, setError] = useState<{ error: PrListsError; message?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTabState] = useState<PrTab>(readTab)
  const [selUrl, setSelUrl] = useState<string | null>(null) // by PR: a reorder keeps it
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
  const apply = useCallback((res: PrListsResult | null, r: PrListsRequest, asked: number) => {
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
    const lists = withEdits(res.lists, edited, asked)
    setLists(lists)
    setAt(Date.now())
    last = { lists, at: Date.now(), closed: r.closed, key: keyOf(r) }
  }, [])

  const listsRef = useRef(lists)
  listsRef.current = lists

  const [, setEditsShown] = useState(0)
  const setEdit = (url: string, busy: string | null, error: string | null) => {
    edits.set(url, { busy, error })
    if (edits.size > 50) edits.delete(edits.keys().next().value!)
    if (alive.current) setEditsShown((n) => n + 1)
  }

  // Requests (or un-requests) a review: the PR's row after it goes in every tab, and in the
  // kept answer (guessed when gh made the change but the PR couldn't be asked for again).
  const editReviewer = useCallback(
    async (pr: PrRow, login: string, add: boolean): Promise<void> => {
      if (edits.get(pr.url)?.busy) return
      setEdit(pr.url, login, null)
      let error: string | null = null
      try {
        const { cwd, wsl } = reqRef.current
        const res = await ipc
          .prReviewers({
            repo: pr.repo,
            number: pr.number,
            add: add ? [login] : [],
            remove: add ? [] : [login],
            cwd,
            wsl,
          })
          .catch((): PrReviewersResult => ({ ok: false, error: "failed" }))
        if (!res.ok) {
          error = prErrorText(res)
          return
        }
        const row = res.row ?? guessRow(findRow(listsRef.current, pr.url) ?? pr, login, add)
        edited.delete(row.url)
        edited.set(row.url, editedFrom(row, Date.now()))
        if (edited.size > 50) edited.delete(edited.keys().next().value!)
        if (alive.current) setLists((l) => (l ? patchRow(l, row) : l))
        if (last) last = { ...last, lists: patchRow(last.lists, row) }
      } finally {
        setEdit(pr.url, null, error)
      }
    },
    [],
  )

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
    const asked = Date.now()
    const res = await ipc.prLists(r).catch(() => null)
    busy.current = false
    if (!alive.current) return
    setLoading(false)
    const stale = keyOf(reqRef.current) !== keyOf(r)
    if (!stale) apply(res, r, asked)
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
    // Another request: its own last answer or none, and gh is asked again even if it was
    // missing or logged out before (maybe fixed since).
    halted.current = false
    if (last?.key !== reqKey) {
      setLists(null)
      setAt(0)
    }
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
  const selIdx = rows.findIndex((r) => r.url === selUrl)
  const row = rows[Math.max(selIdx, 0)] // gone from the list: the first
  const move = (by: number) => {
    const next = rows[Math.min(Math.max(Math.max(selIdx, 0) + by, 0), rows.length - 1)]
    if (next) setSelUrl(next.url)
  }

  const setTab = (t: PrTab) => {
    setTabState(t)
    setSelUrl(null)
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
    if (e.metaKey || e.ctrlKey || e.altKey) return // app and OS shortcuts stay theirs
    // A focused button or checkbox keeps Enter and Space; the dialog's other keys still work.
    const target = e.target as HTMLElement
    // typing, not commands
    if (target.isContentEditable || target.matches?.(TEXT_FIELD)) return
    const control = target.closest("button, input, select, textarea, a")
    if (control && (k === "Enter" || k === " ")) return
    const t = tabFor(k, shownTab, tabs)
    if (t) {
      e.preventDefault()
      return setTab(t)
    }
    if (k === "ArrowDown" || k === "j") {
      e.preventDefault()
      move(1)
    } else if (k === "ArrowUp" || k === "k") {
      e.preventDefault()
      move(-1)
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
  // A focused control that went away (the picker closed, a request removed): back to the
  // dialog, or its keys stop working.
  const refocusDialog = useCallback(() => rootRef.current?.focus(), [])
  // A focused control that went away (the picker, a removed request, a detail link): focus
  // falls to the page, and the dialog's keys with it. After every render, and on focusout.
  useEffect(() => {
    if (document.activeElement === document.body) refocusDialog()
  })
  const onBlur = () =>
    setTimeout(() => {
      if (alive.current && document.activeElement === document.body) refocusDialog()
    })
  useEffect(() => {
    listRef.current?.querySelector(".pr-row.sel")?.scrollIntoView?.({ block: "nearest" })
  }, [row?.url, shownTab])

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
        onBlur={onBlur}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pr-header">
          <GitPullRequest size={16} />
          <h2>Pull requests</h2>
          <span className="pr-age">
            {loading ? "Refreshing…" : at ? `Updated ${ago(now - at)}` : ""}
          </span>
          <button className="iconbtn" title="Refresh (r)" onClick={() => void refresh()}>
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
            {prErrorText(error)}
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
            {rows.map((r) => (
              <PrListRow
                key={r.url}
                row={r}
                selected={r === row}
                showRepo={shownTab !== "repo"}
                panes={panes.get(r.url) ?? []}
                onSelect={() => setSelUrl(r.url)}
              />
            ))}
          </div>
          <div className="pr-detail">
            {row ? (
              <>
                <PrSummary
                  row={row}
                  panes={(panes.get(row.url) ?? []).map((id) => ({
                    id,
                    title: displaySessionTitle(sessions[id], home),
                  }))}
                  onPane={goToPane}
                  reviewers={
                    <PrReviewers
                      key={row.url}
                      row={row}
                      cwd={req.cwd}
                      wsl={req.wsl}
                      onEdit={editReviewer}
                      busy={edits.get(row.url)?.busy ?? null}
                      error={edits.get(row.url)?.error ?? null}
                      refocus={refocusDialog}
                    />
                  }
                />
                <PrDetailView
                  key={row.url}
                  row={row}
                  cwd={req.cwd}
                  wsl={req.wsl}
                  // Threads open in the editor when the focused checkout is this PR's repo on
                  // its branch (the threads' lines are the PR's), at the repo's root; host
                  // only (the editor can't open a WSL pane's Linux path).
                  checkout={
                    !req.wsl &&
                    checkout.root &&
                    checkout.branch === row.head &&
                    !row.fork &&
                    lists?.repoName?.toLowerCase() === row.repo.toLowerCase()
                      ? checkout.root
                      : undefined
                  }
                />
              </>
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
  reviewers: React.ReactNode
}) {
  const { row, panes, onPane, reviewers } = props
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
      {reviewers}
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
