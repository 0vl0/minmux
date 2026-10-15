import { describe, expect, it } from "vitest"
import {
  attribute,
  commOf,
  killOrder,
  parseMarkers,
  parsePs,
  stillRunning,
  type Snapshot,
} from "./proc-snapshot"

const UID = 501
// pid ppid uid cpu rss lstart command (`ps -axww -o pid=,ppid=,uid=,pcpu=,rss=,lstart=,command=`)
const row = (pid: number, ppid: number, command: string, o: { uid?: number; cpu?: number } = {}) =>
  `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${o.uid ?? UID}   ${o.cpu ?? 0.0}  2048 Thu Oct  1 19:02:17 2026     ${command}`

// A pane: shell 100 → claude 110 → (zsh 120 → npm 121 → node 122), (vite 130); the user's own
// `ls` 140 straight under the shell; a codex 200 in another pane (shell 199) with its child 201.
const PS = [
  row(1, 0, "/sbin/launchd", { uid: 0 }),
  row(100, 1, "/bin/zsh -il"),
  row(110, 100, "claude", { cpu: 20 }),
  row(120, 110, "/bin/zsh -c npm test"),
  row(121, 120, "npm test"),
  row(122, 121, "/usr/local/bin/node /w/node_modules/.bin/vitest run", { cpu: 50 }),
  row(130, 110, "node /w/node_modules/.bin/vite --port 5173"),
  row(140, 100, "ls -la"),
  row(199, 1, "/bin/zsh -il"),
  row(200, 199, "/opt/codex/bin/codex"),
  row(201, 200, "cargo build"),
  row(300, 1, "node server.js"), // detached from pane A
  row(301, 300, "node worker.js"),
  row(400, 1, "node other.js"), // detached from a pane minmux didn't ask about
  row(500, 110, "sudo something", { uid: 0 }), // not the user's
  row(600, 1, "tmux new -d"), // the user's own, detached from pane A
].join("\n")

// What an agent started carries MINMUX_AGENT (minmux's wrapper sets it on the agent); what the
// user runs in the pane doesn't.
const ENV = [
  "  300 node server.js TERM=xterm MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
  "  301 node worker.js MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
  "  400 node other.js MINMUX_PANE_ID=pane-Z MINMUX_AGENT=claude HOME=/h",
  "  122 node vitest MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
  "  600 tmux new -d MINMUX_PANE_ID=pane-A HOME=/h",
  "  100 /bin/zsh HOME=/h", // the pane's shell, read: no marks
].join("\n")

const panes = [
  { paneId: "pane-A", shellPid: 100 },
  { paneId: "pane-B", shellPid: 199 },
]
const NAMES = new Set(["claude", "codex", "opencode"])

describe("parsePs", () => {
  it("reads every column, the start time in ms, the program's name", () => {
    const snap = parsePs(PS)
    expect(snap.size).toBe(16)
    expect(snap.get(122)).toEqual({
      pid: 122,
      ppid: 121,
      uid: UID,
      cpu: 50,
      rssKb: 2048,
      started: Date.parse("Thu Oct 1 19:02:17 2026"),
      command: "/usr/local/bin/node /w/node_modules/.bin/vitest run",
      comm: "node",
    })
  })

  it("skips what isn't a process line", () => {
    expect(parsePs("garbage\n\n  PID PPID").size).toBe(0)
    expect(commOf("  /usr/bin/env  node x")).toBe("env")
  })
})

describe("parseMarkers", () => {
  it("reads the pane a process came from out of its environment", () => {
    expect(parseMarkers(ENV)).toEqual(
      new Map([
        [300, { pane: "pane-A", agent: "claude" }],
        [301, { pane: "pane-A", agent: "claude" }],
        [400, { pane: "pane-Z", agent: "claude" }],
        [122, { pane: "pane-A", agent: "claude" }],
        [600, { pane: "pane-A" }],
      ]),
    )
    expect(parseMarkers("  9 x NOT_MINMUX_PANE_ID=y HOME=/h").size).toBe(0)
  })
})

describe("attribute", () => {
  const out = attribute(parsePs(PS), parseMarkers(ENV), panes, UID, NAMES)
  const pids = (pane: string) =>
    (out[pane] ?? []).map((p) => `${"·".repeat(p.depth)}${p.pid}${p.detached ? "d" : ""}`)

  it("lists what the pane's agent runs, as a tree; not the agent, not the user's own commands", () => {
    // Claude (110) found by name; ls (140) is the user's, not the agent's; sudo (500) not theirs.
    expect(pids("pane-A")).toEqual(["120", "·121", "··122", "130", "300d", "·301d"])
  })

  it("an agent running its command (Codex here) lists its children", () => {
    expect(pids("pane-B")).toEqual(["201"])
  })

  it("an agent marked by minmux's wrapper is one whatever its program (its parent isn't marked)", () => {
    const ps = [
      row(1, 0, "/sbin/launchd", { uid: 0 }),
      row(100, 1, "/bin/zsh"),
      row(800, 100, "node /x/agent.js"),
      row(801, 800, "pytest"),
    ].join("\n")
    const env = [
      "  800 node MINMUX_PANE_ID=pane-A MINMUX_AGENT=codex HOME=/h",
      "  801 pytest MINMUX_PANE_ID=pane-A MINMUX_AGENT=codex HOME=/h",
    ].join("\n")
    const r = attribute(parsePs(ps), parseMarkers(env), [panes[0]!], UID, new Set())
    expect((r["pane-A"] ?? []).map((p) => p.pid)).toEqual([801])
    // Without the mark, a pid alone never makes a process an agent (it may have been reused).
    expect(attribute(parsePs(ps), new Map(), [panes[0]!], UID, new Set())["pane-A"]).toEqual([])
  })

  it("a detached process goes to the pane its environment names, only if that pane was asked", () => {
    expect(JSON.stringify(out)).not.toContain('"pid":400')
  })

  it("the user's own program detached from the pane (no agent mark) isn't listed", () => {
    expect(JSON.stringify(out)).not.toContain('"pid":600')
  })

  it("a detached tree through a process whose environment is hidden is listed once", () => {
    // 700 (marked) → 701 /bin/sh (an Apple binary: no environment) → 702 (marked)
    const ps = [
      row(1, 0, "/sbin/launchd", { uid: 0 }),
      row(100, 1, "/bin/zsh"),
      row(700, 1, "npm run dev"),
      row(701, 700, "/bin/sh -c vite"),
      row(702, 701, "node vite"),
    ].join("\n")
    const env = [
      "  700 npm MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
      "  702 node MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
    ].join("\n")
    const r = attribute(parsePs(ps), parseMarkers(env), [panes[0]!], UID, NAMES)
    expect((r["pane-A"] ?? []).map((p) => `${"·".repeat(p.depth)}${p.pid}`)).toEqual([
      "700",
      "·701",
      "··702",
    ])
  })

  it("an agent started by an agent is one of its tasks: listed under the outer one", () => {
    const nested = PS + "\n" + row(150, 121, "claude -p review") + "\n" + row(151, 150, "git diff")
    const r = attribute(parsePs(nested), new Map(), [panes[0]!], UID, NAMES)
    const list = (r["pane-A"] ?? []).map((p) => p.pid)
    expect(list).not.toContain(150) // an agent is never a row: what it runs is
    expect(list).toContain(151)
    expect(list.filter((p) => p === 151)).toHaveLength(1) // once, not again under the inner one
  })

  it("an agent installed through npm: its node shim and real binary are both left out", () => {
    // The wrapper marks the shim (node …/bin/codex); its child is the real codex binary.
    const ps = [
      row(1, 0, "/sbin/launchd", { uid: 0 }),
      row(100, 1, "/bin/zsh"),
      row(900, 100, "node /opt/homebrew/bin/codex"),
      row(901, 900, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex"),
      row(902, 901, "cargo test"),
    ].join("\n")
    const env = [
      "  900 node MINMUX_PANE_ID=pane-A MINMUX_AGENT=codex HOME=/h",
      "  901 codex MINMUX_PANE_ID=pane-A MINMUX_AGENT=codex HOME=/h",
    ].join("\n")
    const r = attribute(parsePs(ps), parseMarkers(env), [panes[0]!], UID, NAMES)
    expect((r["pane-A"] ?? []).map((p) => `${p.depth}:${p.pid}`)).toEqual(["0:902"])
  })

  it("a marked process under a hidden-environment process isn't taken for an agent", () => {
    // Claude's tool shell (an Apple /bin/zsh: its environment hidden) runs npm (marked).
    const ps = [
      row(1, 0, "/sbin/launchd", { uid: 0 }),
      row(100, 1, "/bin/zsh"),
      row(110, 100, "claude"),
      row(120, 110, "/bin/zsh -c npm test"),
      row(121, 120, "npm test"),
    ].join("\n")
    const env = [
      "  110 claude MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
      "  121 npm MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
    ].join("\n")
    const r = attribute(parsePs(ps), parseMarkers(env), [panes[0]!], UID, NAMES)
    expect((r["pane-A"] ?? []).map((p) => `${p.depth}:${p.pid}`)).toEqual(["0:120", "1:121"])
  })

  it("the agent is the first marked process down a branch, under whatever started it", () => {
    // `time claude` in the pane: an unmarked process between the shell and the agent.
    const ps = [
      row(1, 0, "/sbin/launchd", { uid: 0 }),
      row(100, 1, "/bin/zsh"),
      row(105, 100, "time claude"),
      row(110, 105, "node /x/claude-cli.js"),
      row(120, 110, "pytest"),
    ].join("\n")
    const env = [
      "  110 node MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
      "  120 pytest MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
    ].join("\n")
    const r = attribute(parsePs(ps), parseMarkers(env), [panes[0]!], UID, NAMES)
    expect((r["pane-A"] ?? []).map((p) => `${p.depth}:${p.pid}`)).toEqual(["0:120"])
  })

  it("a pane whose shell is gone: nothing", () => {
    const r = attribute(parsePs(PS), new Map(), [{ paneId: "x", shellPid: 999 }], UID, NAMES)
    expect(r).toEqual({})
  })
})

describe("killOrder", () => {
  it("everything under a process, deepest first, then it", () => {
    const snap: Snapshot = parsePs(PS)
    expect(killOrder(snap, 120).map((p) => p.pid)).toEqual([122, 121, 120])
    expect(killOrder(snap, 120)[0]!.started).toBe(snap.get(122)!.started)
    expect(killOrder(snap, 999)).toEqual([])
  })

  it("stillRunning: only the ones with the same start (a reused pid isn't)", () => {
    const snap: Snapshot = parsePs(PS)
    const started = snap.get(121)!.started
    expect(
      stillRunning(new Map([...snap].map(([pid, p]) => [pid, p.started])), [
        { pid: 121, started },
        { pid: 122, started: started + 60_000 },
        { pid: 999, started },
      ]),
    ).toEqual([{ pid: 121, started }])
  })
})
