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
  type GhAccount,
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
import { withHeld } from "../lib/pr-reviewers"
import { heldRows, usePrEdits } from "./pr-edits"
import { refKey, type PrRef } from "../lib/pr-detail"
import { baseOf, stackedOn, stackRows, type StackRow } from "../lib/pr-stacks"

// gh's accounts as last answered (a failed answer too): the picker stays to pick another.
let knownAccounts: GhAccount[] = []
// The last answer, kept across opens: shown at once (with its age) while a refresh runs.
let last: { lists: PrLists; at: number; closed: boolean; key: string } | null = null
const TAB_KEY = "minmux.prDialog.tab"
const TEXT_FIELD =
  "textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])"

const readTab = (): PrTab => {
  try {
    const t = localStorage.getItem(TAB_KEY) as PrTab | null
    return t && PR_TABS.includes(t) ? t : "mine"
  } catch {
    return "mine"
  }
}

const keyOf = (r: PrListsRequest) =>
  JSON.stringify([r.cwd ?? "", r.wsl ? (r.wsl.distro ?? "") : null, r.closed, r.account ?? null])

const ACCOUNT_KEY = "minmux.prDialog.account"
const readAccount = (): string | undefined => {
  try {
    return localStorage.getItem(ACCOUNT_KEY) || undefined
  } catch {
    return undefined
  }
}

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
function useFocusedRequest(closed: boolean, account: string | undefined): PrListsRequest {
  const sid = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId)
  const session = useStore((s) => (sid ? s.sessions[sid] : undefined))
  const root = useStore((s) => (sid ? s.paneGit[sid]?.root : undefined))
  return useMemo(() => {
    const who = account ? { account } : {}
    if (!session || session.remote) return { closed, ...who } // an ssh pane has no checkout
    const wsl = wslContext(session.command, session.args)
    const cwd = root ?? session.cwd
    return cwd ? { cwd, wsl, closed, ...who } : { wsl, closed, ...who }
  }, [session, root, closed, account])
}

/** The pull requests dialog: mine, review requested, the focused pane's repo. */
export function PrDialog() {
  const [closed, setClosed] = useState(last?.closed ?? false)
  // One gh account's lists, or (none) every account's.
  const [account, setAccountState] = useState<string | undefined>(readAccount)
  const setAccount = (a: string | undefined) => {
    setAccountState(a)
    try {
      if (a) localStorage.setItem(ACCOUNT_KEY, a)
      else localStorage.removeItem(ACCOUNT_KEY)
    } catch {
      // per-viewer convenience only
    }
  }
  const req = useFocusedRequest(closed, account)
  const checkout = useFocusedCheckout()
  // Only for the same request (the same repo and "closed"): another pane's repo isn't shown.
  const mine = last?.key === keyOf(req) ? last : null
  const [answer, setAnswer] = useState<PrLists | null>(mine?.lists ?? null)
  const [at, setAt] = useState(mine?.at ?? 0)
  const [error, setError] = useState<{ error: PrListsError; message?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTabState] = useState<PrTab>(readTab)
  const [selUrl, setSelUrl] = useState<string | null>(null) // by PR: a reorder keeps it
  const [now, setNow] = useState(Date.now())
  // The answer with the PRs just changed from here in place (their own rows: search lags).
  const edits = usePrEdits()
  const lists = useMemo(
    () => (answer ? withHeld(answer, heldRows()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `edits` / `now`: when to look again
    [answer, edits, now],
  )
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
  const [accounts, setAccounts] = useState<GhAccount[]>(knownAccounts)
  const [fresh, setFresh] = useState(false) // `accounts` came from this dialog's own answer
  const apply = useCallback((res: PrListsResult | null, r: PrListsRequest) => {
    const accs = res ? (res.ok ? res.lists.accounts : res.accounts) : undefined
    if (accs) {
      knownAccounts = accs
      setAccounts(accs)
      setFresh(true)
    }
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
    setAnswer(res.lists)
    setAt(Date.now())
    last = { lists: res.lists, at: Date.now(), closed: r.closed, key: keyOf(r) }
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
    // Another request: its own last answer or none, and gh is asked again even if it was
    // missing or logged out before (maybe fixed since).
    halted.current = false
    if (last?.key !== reqKey) {
      setAnswer(null)
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
  // Every PR the lists know (each once): a stack's base or a link may be in another tab.
  const all = useMemo(() => {
    const seen = new Map<string, PrRow>()
    for (const t of PR_TABS)
      for (const r of lists?.[t] ?? []) if (!seen.has(r.url)) seen.set(r.url, r)
    return [...seen.values()]
  }, [lists])
  const stack = useMemo(
    () => stackRows((lists?.[shownTab] ?? []) as PrRow[], all),
    [lists, shownTab, all],
  )
  const rows = useMemo(() => stack.map((s) => s.row), [stack])
  const selIdx = rows.findIndex((r) => r.url === selUrl)
  const row = rows[Math.max(selIdx, 0)] // gone from the list: the first
  const move = (by: number) => {
    const next = rows[Math.min(Math.max(Math.max(selIdx, 0) + by, 0), rows.length - 1)]
    if (next) setSelUrl(next.url)
  }

  // `remember`: a tab the user picked (one a link moved to isn't kept for the next open).
  const setTab = (t: PrTab, sel: string | null = null, remember = true) => {
    setTabState(t)
    setSelUrl(sel)
    if (!remember) return
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // per-viewer convenience only
    }
  }

  // A PR named in the dialog (a stack, a link): selected where it's listed, this tab first.
  // Not in any list: false (the caller opens it on GitHub).
  const goTo = (pr: PrRef): boolean => {
    const key = refKey(pr)
    const here = rows.find((r) => refKey(r) === key)
    if (here) {
      setSelUrl(here.url)
      return true
    }
    const t = tabs.find((t) => (lists?.[t] ?? []).some((r) => refKey(r) === key))
    const r = t && lists?.[t]?.find((r) => refKey(r) === key)
    if (!t || !r) return false
    setTab(t, r.url, false)
    return true
  }
  // Stable for the memoised detail view (it re-renders for its own PR, and new lists).
  const goToRef = useRef(goTo)
  goToRef.current = goTo
  const goToStable = useCallback((pr: PrRef) => goToRef.current(pr), [])

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
  const refocusDialog = useCallback(() => rootRef.current?.focus(), [])
  // A focused control that went away (the picker, a removed request, a detail link): focus
  // falls to the page, and the dialog's keys with it.
  const onBlur = () =>
    setTimeout(() => {
      if (alive.current && document.activeElement === document.body) refocusDialog()
    })
  useEffect(() => {
    listRef.current?.querySelector(".pr-row.sel")?.scrollIntoView?.({ block: "nearest" })
  }, [row?.url, shownTab])

  const several = accounts.length > 1
  // A saved pick that's logged out or signed out since (as this environment's gh answered):
  // every account's lists again.
  useEffect(() => {
    if (!fresh || !account || !accounts.length) return
    if (!accounts.some((a) => a.login === account && a.ok)) setAccount(undefined)
  }, [fresh, accounts, account])
  const label = (t: PrTab) =>
    t === "mine"
      ? "Mine"
      : t === "review"
        ? "Review requested"
        : `${lists?.repoName ?? "Repo"}${several && lists?.repoAccount ? ` · @${lists.repoAccount}` : ""}`

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
          <AccountPicker accounts={accounts} account={account} onPick={setAccount} />
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
                  : shownTab === "repo" && lists.repoVisible === false
                    ? `${account ? `@${account} can't` : several ? "No logged-in gh account can" : "gh's account can't"} see ${lists.repoName}.${several && account ? " Pick another account, or All accounts." : ""}`
                    : "No pull requests."}
              </div>
            )}
            {!lists && !error && <div className="pr-empty">Loading…</div>}
            {stack.map((s) => (
              <PrListRow
                key={s.row.url}
                stack={s}
                selected={s.row === row}
                showRepo={shownTab !== "repo"}
                showAccount={several && !account}
                panes={panes.get(s.row.url) ?? []}
                onSelect={() => setSelUrl(s.row.url)}
                onGo={goTo}
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
                  base={baseOf(row, all)}
                  above={stackedOn(row, all)}
                  onGo={goTo}
                  reviewers={
                    <PrReviewers
                      key={row.url}
                      row={row}
                      cwd={req.cwd}
                      wsl={req.wsl}
                      account={row.account}
                      showAccount={several}
                    />
                  }
                />
                <PrDetailView
                  key={row.url}
                  row={row}
                  listed={all}
                  onGo={goToStable}
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

/** Which gh account the dialog runs as: gh's only one, or a pick among several (all: each). */
function AccountPicker(props: {
  accounts: GhAccount[]
  account: string | undefined
  onPick: (account: string | undefined) => void
}) {
  const { accounts, account, onPick } = props
  if (accounts.length === 0) return null
  if (accounts.length === 1)
    return (
      <span className="pr-account" title="gh's account">
        as @{accounts[0]!.login}
      </span>
    )
  const shown = accounts.some((a) => a.login === account) ? account : undefined
  return (
    <select
      className="pr-accounts"
      aria-label="GitHub account"
      title="The gh account the dialog runs as (gh's own active account is left as it is)"
      value={shown ?? ""}
      onChange={(e) => onPick(e.target.value || undefined)}
    >
      <option value="">All accounts ({accounts.length})</option>
      {accounts.map((a) => (
        <option key={a.login} value={a.login} disabled={!a.ok}>
          @{a.login}
          {a.active ? " (gh's active)" : ""}
          {a.ok ? "" : " (signed out)"}
        </option>
      ))}
    </select>
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
  stack: StackRow
  selected: boolean
  showRepo: boolean
  showAccount: boolean // several accounts listed: which one this PR came from
  panes: string[]
  onSelect: () => void
  onGo: (pr: PrRow) => boolean
}) {
  const { stack, selected, showRepo, showAccount, panes, onSelect, onGo } = props
  const { row, depth, last, guides, on } = stack
  return (
    <div
      className={`pr-row${selected ? " sel" : ""}`}
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={() => ipc.openExternal(row.url)}
    >
      {depth > 0 && (
        // stacked on the PR above: one column per level, an ancestor's line running on
        <span className="pr-stack" aria-hidden>
          {guides.map((g, i) => (
            <span key={i}>{g ? "│" : " "}</span>
          ))}
          <span>{last ? "└" : "├"}</span>
        </span>
      )}
      <StateIcon row={row} />
      <div className="pr-row-main">
        <div className="pr-row-title">
          <span className="pr-num">#{row.number}</span> {row.title}
        </div>
        <div className="pr-row-status">
          {showRepo && <span className="pr-repo">{row.repo}</span>}
          {showAccount && row.account && (
            <span className="pr-account" title={`Listed as @${row.account}`}>
              @{row.account}
            </span>
          )}
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
          {on && (
            <button
              className="pr-chip pr-on"
              title={`Stacked on #${on.number}: ${on.title}`}
              onClick={(e) => {
                e.stopPropagation()
                onGo(on)
              }}
            >
              on #{on.number}
            </button>
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
  base: PrRow | null // the PR this one is stacked on
  above: PrRow[] // the PRs stacked on this one
  onGo: (pr: PrRow) => boolean
}) {
  const { row, panes, onPane, reviewers, base, above, onGo } = props
  const link = (pr: PrRow) => (
    <button
      key={pr.url}
      className="pr-ref"
      title={pr.title}
      onClick={() => onGo(pr) || ipc.openExternal(pr.url)}
    >
      #{pr.number}
    </button>
  )
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
      {(base || above.length > 0) && (
        <div className="pr-meta pr-stack-line">
          {base && <>Stacked on {link(base)}</>}
          {base && above.length > 0 && " · "}
          {above.length > 0 && <>Stacked on this: {above.map(link)}</>}
        </div>
      )}
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
