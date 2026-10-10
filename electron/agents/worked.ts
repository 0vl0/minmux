// Where a tool call worked (docs/design/AGENT_EDITED_CHECKOUTS.md §1): the folders of the files
// an edit wrote, or the folder of a Bash call that starts `cd <absolute path> &&`. Shared by the
// normalisers; each one decides by its own tool names. Pure, bounded, never throws.

import os from "node:os"
import path from "node:path"

/** `cd /abs/path && …`: no quotes, `$`, `~`, globs or separators in the path — the one shape
 *  agents use. The OpenCode plugin carries the same pattern (a test pins them together). */
export const CD_PREFIX = /^cd\s+(\/[^\s'"$~;&|<>()*?{}\\\x60]*)\s*&&/
const MAX_COMMAND_SCAN = 4096
const MAX_FOLDERS = 32

/** The folder a Bash command starts in by `cd <abs> &&`, or undefined. */
export function cdPrefix(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined
  return CD_PREFIX.exec(command.slice(0, MAX_COMMAND_SCAN))?.[1]
}

const isPosixAbs = (p: string) => p.startsWith("/")
const isWinAbs = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\")
const flavour = (p: string) => (isWinAbs(p) ? path.win32 : path.posix)

// Never a checkout the user works in: the agents' own config and memory, temp folders, and
// dependency / git internals (a codegen burst there mustn't flood the pane's map).
const HOME = "(?:/Users/[^/]+|/home/[^/]+|/root|[A-Za-z]:[\\\\/]Users[\\\\/][^\\\\/]+)"
const EXCLUDED = [
  new RegExp(`^${HOME}[\\\\/](?:\\.claude|\\.codex|\\.config[\\\\/]opencode)(?:[\\\\/]|$)`, "i"),
  /^\/(?:private\/)?(?:tmp|var\/tmp|var\/folders)(?:\/|$)/,
  /[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)/i,
  /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/,
]
const tmp = os.tmpdir()

function excluded(dir: string): boolean {
  if (EXCLUDED.some((re) => re.test(dir))) return true
  return dir === tmp || dir.startsWith(tmp + path.sep)
}

/** Absolute folders worked in: each file's folder, plus `dirs` as they are. Relative paths
 *  resolve against `cwd` (POSIX rules for a POSIX path, e.g. a WSL pane on Windows), else are
 *  dropped. Excluded folders are left out; undefined when nothing is left. */
export function workedFolders(
  files: unknown[],
  cwd: string | undefined,
  dirs: string[] = [],
): string[] | undefined {
  const out = new Set<string>()
  const abs = (p: string): string | undefined => {
    if (isPosixAbs(p) || isWinAbs(p)) return flavour(p).normalize(p)
    if (!cwd || !(isPosixAbs(cwd) || isWinAbs(cwd))) return undefined
    return flavour(cwd).resolve(cwd, p)
  }
  const add = (dir: string | undefined) => {
    if (!dir || out.size >= MAX_FOLDERS) return
    const trimmed = dir.replace(/[\\/]+$/, "")
    const d = trimmed && !/^[A-Za-z]:$/.test(trimmed) ? trimmed : dir // keep "/" and "C:\\"
    if (!excluded(d)) out.add(d)
  }
  for (const f of files) {
    if (typeof f !== "string" || !f) continue
    const p = abs(f)
    if (p) add(flavour(p).dirname(p))
  }
  for (const d of dirs) add(abs(d))
  return out.size ? [...out] : undefined
}
