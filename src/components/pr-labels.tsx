import { useStore, activeTheme } from "../store"
import { ipc } from "../lib/ipc"
import { labelColors, labelUrl, type PrLabel } from "../lib/pr-labels"
import type { PrRow } from "../lib/pr-dashboard"
import { toDialog } from "./refocus-terminal"

/** A PR's labels as chips in their colours (`max`: the first few, then "+N"); a click opens
 *  the repo's PRs with that label on GitHub. In a list row: clickable labels, no controls. */
export function PrLabels(props: { row: PrRow; max?: number; inRow?: boolean }) {
  // (a row with none: no store subscription, rendered as nothing)
  return props.row.labels?.length ? <Labels {...props} /> : null
}

function Labels({ row, max, inRow }: { row: PrRow; max?: number; inRow?: boolean }) {
  const scheme = useStore((s) => activeTheme(s).scheme)
  const labels = row.labels ?? []
  const shown = max === undefined ? labels : labels.slice(0, max)
  const hidden = labels.slice(shown.length).map((l) => l.name)
  const notAsked = row.moreLabels ?? 0
  const more = hidden.length + notAsked
  const chip = (l: PrLabel) => {
    const what = `${l.name}${l.description ? `: ${l.description}` : ""}`
    const props = {
      className: "pr-chip pr-label",
      style: labelColors(l.color, scheme) ?? undefined,
      title: row.repo ? `${what} · open ${row.repo}'s PRs with it` : what,
      onClick: (e: React.MouseEvent<HTMLElement>) => {
        toDialog(e.currentTarget) // (Enter opens the PR again)
        if (row.repo && e.detail < 2) ipc.openExternal(labelUrl(row.repo, l.name)) // (once)
      },
    }
    return inRow ? (
      <span key={l.name} data-control {...props}>
        {l.name}
      </span>
    ) : (
      <button key={l.name} {...props}>
        {l.name}
      </button>
    )
  }
  const moreTitle = [hidden.join(", "), notAsked ? `${notAsked} more on GitHub` : ""]
    .filter(Boolean)
    .join(", and ")
  return (
    <>
      {shown.map(chip)}
      {more > 0 && (
        <span className="pr-chip pr-label-more" title={moreTitle}>
          +{more}
        </span>
      )}
    </>
  )
}
