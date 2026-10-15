// Links clicked in a terminal or the sidebar: a GitHub PR opens in the pull requests dialog
// (looked up with its pane's gh), anything else in the browser.
import { ipc } from "./ipc"
import { prRefOfUrl } from "./pr-link"
import { wslContext } from "./wsl"
import { useStore } from "../store"
import type { Session } from "../types"

type State = ReturnType<typeof useStore.getState>

/** Where gh runs for a session: its checkout `root` (or folder), WSL or host; ssh: the host. */
export function ghEnvOf(session: Session | undefined, root: string | undefined) {
  if (!session || session.remote) return {}
  const wsl = wslContext(session.command, session.args)
  const cwd = root ?? session.cwd
  return { ...(cwd ? { cwd } : {}), ...(wsl ? { wsl } : {}) }
}

/** Where gh runs for a pane. */
export const paneGhEnv = (s: State, pane: string | undefined) =>
  pane ? ghEnvOf(s.sessions[pane], s.paneGit[pane]?.root) : {}

/** A clicked link (`pane`: the terminal or sidebar row it's in): a PR in the dialog;
 *  `hidden`: its text hides its target (OSC 8), so the browser asks first. */
export function openLink(url: string, pane?: string, hidden = false) {
  const pr = prRefOfUrl(url)
  const s = useStore.getState()
  // (host gh missing: a host pane's PR goes to the browser; a WSL pane has its own gh)
  if (pr && !(s.ghMissing && !paneGhEnv(s, pane).wsl)) s.openPrLink(pr, pane)
  else if (hidden) ipc.openExternalConfirm(url)
  else ipc.openExternal(url)
}
