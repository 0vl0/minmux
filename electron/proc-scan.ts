// Taking the process snapshot for agent processes (proc-snapshot.ts): two `ps` runs, in the
// sessions worker. C locale (a stable `lstart`), bounded in time and output.

import { execFile } from "node:child_process"
import { PS } from "./agent-procs"
import fs from "node:fs"
import { parseLsof, parseMarkers, parsePs, type Marker, type Snapshot } from "./proc-snapshot"

const PS_MS = 2000
const MAX_BYTES = 64 * 1024 * 1024 // environments make -E output large

const run = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      PS,
      args,
      { timeout: PS_MS, maxBuffer: MAX_BYTES, env: { ...process.env, LC_ALL: "C" } },
      (err, out) => (err ? reject(err) : resolve(out)),
    ),
  )

const LSOF = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((p) => fs.existsSync(p))
const LSOF_MS = 1500 // ports are a nicety: never what holds a list back

/** The TCP ports these processes listen on (none without lsof, or when it fails). */
export function listeningPorts(pids: number[]): Promise<Map<number, number[]>> {
  if (!LSOF || !pids.length) return Promise.resolve(new Map())
  return new Promise((resolve, reject) =>
    execFile(
      LSOF,
      // -a: all conditions (these pids AND listening TCP); -n/-P: no name lookups (fast)
      ["-a", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn", "-p", pids.join(",")],
      { timeout: LSOF_MS, maxBuffer: 4 * 1024 * 1024 },
      // lsof exits 1 when none of them listens (and warns on stderr about mounts it can't stat):
      // still an answer. Killed (late) or not started: none.
      (err, out) =>
        err && (err.killed || typeof err.code !== "number")
          ? reject(err)
          : resolve(parseLsof(out ?? "")),
    ),
  )
}

/** Every process, and the pane each one's environment names (when it can be read). */
export async function scan(): Promise<{ snap: Snapshot; markers: Map<number, Marker> }> {
  const [table, envs] = await Promise.all([
    run(["-axww", "-o", "pid=,ppid=,uid=,pcpu=,rss=,lstart=,command="]),
    // Environments are best effort: without them agents are found by their command only, and the
    // detached processes go unseen.
    // BSD ps (macOS) shows environments with `E`; procps (Linux) with `e`.
    run([process.platform === "darwin" ? "-axEww" : "axeww", "-o", "pid=,command="]).catch(
      () => "",
    ),
  ])
  const snap = parsePs(table)
  return { snap, markers: parseMarkers(envs, snap) }
}
