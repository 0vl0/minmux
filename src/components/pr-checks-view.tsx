import { useEffect, useState } from "react"
import {
  ArrowSquareOut,
  CheckCircle,
  CircleDashed,
  MinusCircle,
  XCircle,
} from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import {
  checksRunning,
  type CheckState,
  type PrChecks,
  type PrChecksResult,
} from "../lib/pr-checks"
import { when } from "../lib/pr-detail"

// Last answer per PR (and account): shown at once when it's selected again. Bounded.
const cache = new Map<string, PrChecks>()
const CACHE_MAX = 50
const LIVE_MS = 15_000 // while checks run: asked again this often (only this PR, only while shown)

// No spinner: nothing animates over the terminal panes (a still dashed ring for "running").
const ICON: Record<CheckState, { Icon: typeof CheckCircle; cls: string; word: string }> = {
  passed: { Icon: CheckCircle, cls: "good", word: "passed" },
  failed: { Icon: XCircle, cls: "bad", word: "failed" },
  running: { Icon: CircleDashed, cls: "warn", word: "running" },
  skipped: { Icon: MinusCircle, cls: "", word: "skipped" },
  neutral: { Icon: MinusCircle, cls: "", word: "neutral" },
}

function StateIcon({ state, size = 13 }: { state: CheckState | null; size?: number }) {
  if (!state) return null
  const { Icon, cls, word } = ICON[state]
  return (
    <span className={`pr-check-icon ${cls}`} title={word}>
      <Icon size={size} weight={state === "running" ? "regular" : "fill"} />
    </span>
  )
}

/** The latest commit's checks and the PR's commits, live while its checks run. */
export function PrChecksView(props: {
  row: PrRow
  cwd?: string
  wsl?: { distro?: string }
  onSettled?: () => void // its checks were running and are all done now (the lists catch up)
}) {
  const { row, cwd, wsl, onSettled } = props
  const key = `${row.url}\0${row.account ?? ""}`
  const [checks, setChecks] = useState<PrChecks | undefined>(() => cache.get(key))
  const [error, setError] = useState<string | null>(null)

  // Asked on selection, again when the PR changes (a push), and every LIVE_MS while its
  // checks run: only while the window is visible, and never once they're all done.
  useEffect(() => {
    let live = true
    let wasRunning = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = async () => {
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => void ask(), LIVE_MS)
        return
      }
      const res = await ipc
        .prChecks({ repo: row.repo, number: row.number, cwd, wsl, account: row.account })
        .catch((): PrChecksResult => ({ ok: false, error: "failed" }))
      if (res.ok) {
        cache.delete(key)
        cache.set(key, res.checks)
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
      }
      if (!live) return
      if (!res.ok) {
        if (res.message !== "Superseded") setError(prErrorText(res))
        return
      }
      setError(null)
      setChecks(res.checks)
      if (checksRunning(res.checks)) {
        wasRunning = true
        timer = setTimeout(() => void ask(), LIVE_MS)
      } else if (wasRunning) {
        wasRunning = false
        onSettled?.()
      }
    }
    void ask()
    return () => {
      live = false
      clearTimeout(timer)
    }
    // env is the focused pane's: a new one doesn't change the PR's checks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, row.updatedAt])

  if (!checks) return error ? <div className="pr-faint">{error}</div> : null
  const count = (s: CheckState) => checks.checks.filter((c) => c.state === s).length
  const summary = (["failed", "running", "passed"] as const)
    .map((s) => (count(s) ? `${count(s)} ${ICON[s].word}` : ""))
    .filter(Boolean)
    .join(", ")
  const commits = [...checks.commits].reverse() // newest first
  return (
    <div className="pr-checks">
      <h4>
        Checks {summary && <span className="pr-as">({summary})</span>}
        {checksRunning(checks) && <span className="pr-as"> · updating live</span>}
      </h4>
      {error && <div className="pr-error stale">{error} Showing the last answer.</div>}
      {checks.checks.length === 0 ? (
        <div className="pr-faint">No checks on the latest commit.</div>
      ) : (
        <ul className="pr-check-list">
          {checks.checks.map((c, i) => (
            <li key={`${c.workflow}/${c.name}/${i}`}>
              <StateIcon state={c.state} />
              <span className="pr-check-name">{c.name}</span>
              {c.workflow && <span className="pr-faint">{c.workflow}</span>}
              {c.url && (
                <button
                  className="pr-link"
                  title="Open its log"
                  onClick={() => ipc.openExternal(c.url)}
                >
                  <ArrowSquareOut size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h4>Commits ({commits.length + checks.moreCommits})</h4>
      <ul className="pr-commit-list">
        {commits.map((c) => (
          <li key={c.oid}>
            <StateIcon state={c.state} size={12} />
            <button
              className="pr-ref"
              title="Open on GitHub"
              onClick={() => ipc.openExternal(c.url)}
            >
              {c.oid}
            </button>
            <span className="pr-commit-headline">{c.headline}</span>
            <span className="pr-faint">
              {c.author} · {when(c.at)}
            </span>
          </li>
        ))}
        {checks.moreCommits > 0 && (
          <li className="pr-faint">{checks.moreCommits} older commits not listed</li>
        )}
      </ul>
    </div>
  )
}
