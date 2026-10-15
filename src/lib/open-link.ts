import { ipc } from "./ipc"
import { prRefOfUrl } from "./pr-link"
import { useStore } from "../store"

/** A clicked link: a GitHub PR opens in the pull requests dialog, anything else in the browser
 *  (as does a PR while gh isn't installed: the dialog couldn't show it). */
export function openLink(url: string) {
  const pr = prRefOfUrl(url)
  const s = useStore.getState()
  if (pr && !s.ghMissing) s.openPrLink(pr)
  else ipc.openExternal(url)
}
