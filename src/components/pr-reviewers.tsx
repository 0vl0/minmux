import { useEffect, useMemo, useRef, useState } from "react"
import { Plus, UsersThree, X } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import { PR_ERRORS, type PrRow } from "../lib/pr-dashboard"
import {
  pickerEntries,
  type PickerEntry,
  type PrCandidates,
  type PrCandidatesResult,
  type PrReviewersResult,
} from "../lib/pr-reviewers"

const DEBOUNCE_MS = 250 // typing: only the text it stops on is searched

const REVIEWER_WORD: Record<PrRow["reviewers"][number]["state"], string> = {
  approved: "approved",
  changes: "changes requested",
  commented: "commented",
  dismissed: "dismissed",
}

type Env = { cwd?: string; wsl?: { distro?: string } }

const failure = (res: { error: keyof typeof PR_ERRORS; message?: string }) =>
  `${PR_ERRORS[res.error]}${res.message ? ` ${res.message}` : ""}`

/** The PR's reviewers, with requests added (the picker) or removed by an explicit click. */
// onRow: the PR after a change; `fetched` false when it was only guessed (gh made the change,
// asking for the PR again failed), so a later list answer replaces it.
export function PrReviewers(
  props: Env & { row: PrRow; onRow: (row: PrRow, fetched: boolean) => void },
) {
  const { row, cwd, wsl, onRow } = props
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // the login being changed
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  // Merged and closed PRs take no more requests.
  const canEdit = row.state === "open" || row.state === "draft"

  const edit = async (login: string, add: boolean) => {
    if (busy) return
    setBusy(login)
    setError(null)
    const res = await ipc
      .prReviewers({
        repo: row.repo,
        number: row.number,
        add: add ? [login] : [],
        remove: add ? [] : [login],
        cwd,
        wsl,
      })
      .catch((): PrReviewersResult => ({ ok: false, error: "failed" }))
    if (!alive.current) return
    setBusy(null)
    if (!res.ok) return setError(failure(res))
    if (res.row) return onRow(res.row, true)
    const requested = row.requested.filter((r) => r !== login)
    onRow({ ...row, requested: add ? [...requested, login] : requested }, false)
  }

  const pending = row.requested.filter((r) => !row.reviewers.some((v) => v.login === r))
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
            </li>
          ))}
          {pending.map((login) => (
            <li key={login}>
              {login} <span className="pr-chip warn">requested</span>
              {canEdit && (
                <button
                  className="pr-link"
                  title={`Remove the review request for ${login}`}
                  disabled={!!busy}
                  onClick={() => void edit(login, false)}
                >
                  <X size={11} />
                </button>
              )}
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
  const [candidates, setCandidates] = useState<PrCandidates | null>(null)
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
            if (!res.ok) return setError(failure(res))
            setError(null)
            setCandidates(res.candidates)
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
    () => (candidates ? pickerEntries(candidates, row) : []),
    [candidates, row],
  )
  const pick = (e: PickerEntry | undefined) => {
    if (e && e.status !== "requested" && !busy) onPick(e)
  }

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView?.({ block: "nearest" })
  }, [sel])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      // Closes the picker only, not the dialog.
      e.preventDefault()
      e.stopPropagation()
      return onClose()
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const by = e.key === "ArrowDown" ? 1 : -1
      setSel((s) => Math.min(Math.max(s + by, 0), Math.max(entries.length - 1, 0)))
    } else if (e.key === "Enter") {
      e.preventDefault()
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
        />
        <button className="iconbtn" title="Close (Esc)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {error && <div className="pr-error">{error}</div>}
      {!error && entries.length === 0 && (
        <div className="pr-faint">
          {loading ? "Searching…" : query ? "Nobody matches." : "Type to search."}
        </div>
      )}
      <ul className="pr-picker-list" ref={listRef} role="listbox" aria-label="Reviewers">
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
      {candidates?.teams === "no-scope" && (
        <div className="pr-faint">
          Teams need gh's read:org scope: run <code>gh auth refresh -s read:org</code>.
        </div>
      )}
    </div>
  )
}
