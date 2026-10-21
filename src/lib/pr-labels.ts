// A PR's labels in the pull requests dialog (parsed with the lists' rows: pr-dashboard),
// coloured for the theme (a label's colour is picked for GitHub's light page: its text is lightened on a dark
// theme, darkened on a light one, over a tint of it), and the repo's PRs with one. Pure.
/** One label on a PR. */
export interface PrLabel {
  name: string
  color: string // hex, no "#" ("" when GitHub gave none that parses)
  description: string
}

export const LABELS = 10 // asked for per PR, in every list row (more: "+N" counts them)
export const ROW_LABELS = 3 // shown in a list row

/** A label's chip colours on a dark or light theme (null: no colour, the plain chip). */
export function labelColors(
  hex: string,
  scheme: "dark" | "light",
): { background: string; borderColor: string; color: string } | null {
  if (!/^[0-9a-f]{6}$/.test(hex)) return null
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const [h, s, l] = hsl(r!, g!, b!)
  const tint = (a: number) => `rgba(${r}, ${g}, ${b}, ${a})`
  // (enough contrast on the theme's own background: GitHub's dark mode does the same)
  const text = scheme === "dark" ? Math.max(l, 70) : Math.min(l, 32)
  return {
    background: tint(scheme === "dark" ? 0.18 : 0.14),
    // (the text's own shade: a pale label's border would vanish on a light theme)
    borderColor: `hsla(${h}, ${s}%, ${text}%, 0.45)`,
    color: `hsl(${h}, ${s}%, ${text}%)`,
  }
}

/** rgb 0–255 → hue (degrees), saturation and lightness (percent), rounded. */
function hsl(r: number, g: number, b: number): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255]
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  const d = max - min
  if (!d) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h =
    max === rr ? ((gg - bb) / d + 6) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)]
}

// (a name with a quote can't be searched for: the label's own page, its issues and PRs)
/** The repo's pull requests with a label, on GitHub. */
export const labelUrl = (repo: string, name: string) =>
  name.includes('"')
    ? `https://github.com/${repo}/labels/${encodeURIComponent(name)}`
    : `https://github.com/${repo}/pulls?q=${encodeURIComponent(`is:pr label:"${name}"`)}`
