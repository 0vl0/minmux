// Colour-scheme updates for programs in a terminal (DEC mode 2031, the "theme notify" protocol
// Claude Code and OpenCode turn on): they ask to be told when the terminal goes dark or light,
// then re-read its colours and redraw. Pure: the terminal manager wires it to each xterm.

/** The DEC private mode a program sets to be told of scheme changes. */
export const THEME_MODE = 2031

/** What the terminal reports (on a change, or asked with `CSI ? 996 n`): 1 = dark, 2 = light. */
export const schemeReport = (scheme: "dark" | "light") => `\x1b[?997;${scheme === "dark" ? 1 : 2}n`

/** The answer to `CSI ? 2031 $ p` (DECRQM): set (1) or reset (2), so the mode reads as known. */
export const modeReport = (on: boolean) => `\x1b[?${THEME_MODE};${on ? 1 : 2}$y`

// xterm's form: each param, then an array of its sub-params (`CSI ? 1000:2031 h` = [1000, [2031]]);
// a sub-parameter isn't a mode, nor is the mode given sub-parameters (`2031:1`).
/** Do these DECSET / DECRST params (`CSI ? … h|l`) include the mode? */
export const namesThemeMode = (params: (number | number[])[]): boolean =>
  params.some((p, i) => p === THEME_MODE && !Array.isArray(params[i + 1]))

/** Where a pane is: what the shell reports, and what the agents board knows. */
export interface NotifyState {
  optedIn: boolean // the running command turned the mode on
  commandRunning: boolean // the shell says something runs in the foreground
  agentLive: boolean // the pane's agent session on the board is live (from its hooks, not output)
}

// Sending writes to the program's input: only to a live agent that asked, while it runs (never
// to a shell, nor to whatever a crashed agent left in the foreground).
/** Is a palette report sent to this pane now? */
export const reportsTo = (s: NotifyState): boolean => s.optedIn && s.commandRunning && s.agentLive
