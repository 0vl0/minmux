// Taking the process snapshot for agent processes (proc-snapshot.ts): two `ps` runs, in the
// sessions worker. C locale (a stable `lstart`), bounded in time and output.

import { execFile } from "node:child_process"
import { PS } from "./agent-procs"
import { LSTART, parseMarkers, parsePs, type Marker, type Snapshot } from "./proc-snapshot"

const START_LINE = new RegExp(`^\\s*(\\d+)\\s+(${LSTART})`)
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

/** When each of these processes started (gone ones are left out): one small `ps`. */
export async function startTimes(pids: number[]): Promise<Map<number, number>> {
  const times = new Map<number, number>()
  if (!pids.length) return times
  // ps exits 1 when one of the pids is gone: what it printed still counts.
  const out = await new Promise<string>((resolve) =>
    execFile(
      PS,
      ["-o", "pid=,lstart=", "-p", pids.join(",")],
      { timeout: PS_MS, env: { ...process.env, LC_ALL: "C" } },
      (_err, stdout) => resolve(stdout ?? ""),
    ),
  )
  for (const line of out.split("\n")) {
    const m = START_LINE.exec(line)
    const at = m ? Date.parse(m[2]!) : NaN
    if (m && Number.isFinite(at)) times.set(Number(m[1]), at)
  }
  return times
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
