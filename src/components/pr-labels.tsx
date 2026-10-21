import { useStore, activeTheme } from "../store"
import { ipc } from "../lib/ipc"
import { labelColors, labelUrl, type PrLabel } from "../lib/pr-labels"
import type { PrRow } from "../lib/pr-dashboard"

/** A PR's labels as chips in their colours (`max`: the first few, then "+N"); a click opens
 *  the repo's PRs with that label on GitHub. In a list row: clickable labels, no controls. */
export function PrLabels({ row, max, inRow }: { row: PrRow; max?: number; inRow?: boolean }) {
  const scheme = useStore((s) => activeTheme(s).scheme)
  const labels = row.labels ?? []
  if (!labels.length) return null
  const shown = max === undefined ? labels : labels.slice(0, max)
  const more = labels.length - shown.length + (row.moreLabels ?? 0)
  const chip = (l: PrLabel) => {
    const title = `${l.name}${l.description ? `: ${l.description}` : ""} · open ${row.repo}'s PRs with it`
    const props = {
      className: "pr-chip pr-label",
      style: labelColors(l.color, scheme) ?? undefined,
      title,
      onClick: () => ipc.openExternal(labelUrl(row.repo, l.name)),
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
  return (
    <>
      {shown.map(chip)}
      {more > 0 && (
        <span
          className="pr-chip pr-label-more"
          title={
            labels
              .slice(shown.length)
              .map((l) => l.name)
              .join(", ") || `${more} more`
          }
        >
          +{more}
        </span>
      )}
    </>
  )
}
