// Links clicked in a terminal or the sidebar: a GitHub PR opens in the pull requests dialog
// (looked up with its pane's gh), anything else in the browser.
import { ipc } from "./ipc"
import { prRefOfUrl } from "./pr-link"
import { wslContext } from "./wsl"
import { useStore } from "../store"

type State = ReturnType<typeof useStore.getState>

/** Where gh runs for a pane: its checkout (or folder), WSL or host; an ssh pane: the host's. */
export function paneGhEnv(s: State, pane: string | undefined) {
  const session = pane ? s.sessions[pane] : undefined
  if (!session || session.remote) return {}
  const wsl = wslContext(session.command, session.args)
  const cwd = s.paneGit[session.id]?.root ?? session.cwd
  return { ...(cwd ? { cwd } : {}), ...(wsl ? { wsl } : {}) }
}

/** A clicked link (`pane`: the terminal or sidebar row it's in): a PR in the dialog. */
export function openLink(url: string, pane?: string) {
  const pr = prRefOfUrl(url)
  const s = useStore.getState()
  // (host gh missing: a host pane's PR goes to the browser; a WSL pane has its own gh)
  if (pr && !(s.ghMissing && !paneGhEnv(s, pane).wsl)) s.openPrLink(pr, pane)
  else ipc.openExternal(url)
}
