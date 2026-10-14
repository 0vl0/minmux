import { useEffect, useMemo, useRef, useState } from "react"
import { Plus, UsersThree, X } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import {
  pickerEntries,
  type PickerEntry,
  type PrCandidates,
  type PrCandidatesResult,
} from "../lib/pr-reviewers"

const DEBOUNCE_MS = 250 // typing: only the text it stops on is searched

const REVIEWER_WORD: Record<PrRow["reviewers"][number]["state"], string> = {
  approved: "approved",
  changes: "changes requested",
  commented: "commented",
  dismissed: "dismissed",
}

type Env = { cwd?: string; wsl?: { distro?: string } }

/** The PR's reviewers, with requests added (the picker) or removed by an explicit click. */
// onEdit (the dialog's): makes the change and shows it, answering the error to show (or null).
export function PrReviewers(props: {
  row: PrRow
  cwd?: string
  wsl?: { distro?: string }
  onEdit: (row: PrRow, login: string, add: boolean) => Promise<string | null>
  refocus: () => void
}) {
  const { row, cwd, wsl, onEdit, refocus } = props
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // the login being changed
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
      if (document.activeElement === document.body) refocus() // it held the focus
    },
    [refocus],
  )
  // The picker closed, or a request's ✕ went with it: focus back to the dialog.
  useEffect(() => {
    if (document.activeElement === document.body) refocus()
  })
  // Merged and closed PRs take no more requests.
  const canEdit = row.state === "open" || row.state === "draft"

  const edit = async (login: string, add: boolean) => {
    setBusy(login)
    setError(null)
    const err = await onEdit(row, login, add)
    if (!alive.current) return
    setBusy(null)
    setError(err)
  }

  const pending = row.requested.filter((r) => !row.reviewers.some((v) => v.login === r))
  const remove = (login: string) =>
    canEdit && (
      <button
        className="pr-link"
        title={`Remove the review request for ${login}`}
        disabled={!!busy}
        onClick={() => void edit(login, false)}
      >
        <X size={11} />
      </button>
    )
  return (
    <>
      <h4>Reviewers</h4>
      {row.reviewers.length === 0 && pending.length === 0 ? (
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
              {/* asked again after reviewing */}
              {row.requested.includes(r.login) && (
                <>
                  {" "}
                  <span className="pr-chip warn">requested</span>
                  {remove(r.login)}
                </>
              )}
            </li>
          ))}
          {pending.map((login) => (
            <li key={login}>
              {login} <span className="pr-chip warn">requested</span>
              {remove(login)}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="pr-error">{error}</div>}
      {canEdit &&
        (picking ? (
          <ReviewerPicker
            row={row}
            cwd={cwd}
            wsl={wsl}
            busy={busy}
            onPick={(e) => void edit(e.login, true)}
            onClose={() => setPicking(false)}
          />
        ) : (
          <button className="pr-open pr-request" onClick={() => setPicking(true)}>
            <Plus size={13} /> Request reviewer
          </button>
        ))}
    </>
  )
}

const TAG: Record<NonNullable<PickerEntry["status"]>, string> = {
  requested: "requested",
  reviewed: "re-request",
}

/** Search people and teams who can review the repo; GitHub's suggestions first. */
function ReviewerPicker(
  props: Env & {
    row: PrRow
    busy: string | null
    onPick: (e: PickerEntry) => void
    onClose: () => void
  },
) {
  const { row, cwd, wsl, busy, onPick, onClose } = props
  const [query, setQuery] = useState("")
  // with the text they answer: older text's people stay shown, but aren't picked
  const [candidates, setCandidates] = useState<{ q: string; c: PrCandidates } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  // The first ask at once; typing waits for a pause. A reply for older text is dropped.
  const first = useRef(true)
  useEffect(() => {
    let live = true
    setLoading(true)
    const timer = setTimeout(
      () => {
        void ipc
          .prCandidates({ repo: row.repo, number: row.number, query, cwd, wsl })
          .catch((): PrCandidatesResult => ({ ok: false, error: "failed" }))
          .then((res) => {
            if (!live) return
            setLoading(false)
            if (!res.ok) return setError(prErrorText(res))
            setError(null)
            setCandidates({ q: query, c: res.candidates })
            setSel(0)
          })
      },
      first.current ? 0 : DEBOUNCE_MS,
    )
    first.current = false
    return () => {
      live = false
      clearTimeout(timer)
    }
    // env is the focused pane's: a new one doesn't change who can review
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.repo, row.number, query])

  const entries = useMemo(
    () => (candidates ? pickerEntries(candidates.c, row) : []),
    [candidates, row],
  )
  const current = candidates?.q === query
  const pick = (e: PickerEntry | undefined) => {
    if (e && current && e.status !== "requested" && !busy) onPick(e)
  }

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView?.({ block: "nearest" })
  }, [sel])

  // Esc anywhere in the picker closes it, not the dialog.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return
    e.preventDefault()
    e.stopPropagation()
    onClose()
  }
  // The search box's keys move through and pick from the list; nothing reaches the dialog.
  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      e.stopPropagation()
      const by = e.key === "ArrowDown" ? 1 : -1
      setSel((s) => Math.min(Math.max(s + by, 0), Math.max(entries.length - 1, 0)))
    } else if (e.key === "Enter") {
      e.preventDefault()
      e.stopPropagation()
      pick(entries[sel])
    }
  }

  return (
    <div className="pr-picker" onKeyDown={onKeyDown}>
      <div className="pr-picker-head">
        <input
          autoFocus
          type="text"
          spellCheck={false}
          placeholder="Search people and teams"
          aria-label="Search reviewers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
        />
        <button className="iconbtn" title="Close (Esc)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {error && <div className="pr-error">{error}</div>}
      {!error && (entries.length === 0 || !current) && (
        <div className="pr-faint">
          {loading ? "Searching…" : query ? "Nobody matches." : "Type to search."}
        </div>
      )}
      <ul
        className={`pr-picker-list${current ? "" : " stale"}`}
        ref={listRef}
        role="listbox"
        aria-label="Reviewers"
      >
        {entries.map((e, i) => (
          <li
            key={e.login}
            role="option"
            aria-selected={i === sel}
            aria-disabled={e.status === "requested"}
            className={`pr-cand${i === sel ? " sel" : ""}${e.status === "requested" ? " off" : ""}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(e)}
          >
            {e.team && <UsersThree size={13} />}
            <span className="pr-cand-login">{e.login}</span>
            {e.name && <span className="pr-faint">{e.name}</span>}
            {e.suggested && <span className="pr-chip">suggested</span>}
            {e.status && <span className="pr-chip warn">{TAG[e.status]}</span>}
            {busy === e.login && <span className="pr-faint">Requesting…</span>}
          </li>
        ))}
      </ul>
      {candidates?.c.teams === "no-scope" && (
        <div className="pr-faint">
          Teams need gh's read:org scope: run <code>gh auth refresh -s read:org</code>.
        </div>
      )}
    </div>
  )
}
