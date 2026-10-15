import { describe, expect, it } from "vitest"
import {
  attributeAll,
  parseLsof,
  commOf,
  looksLikeAgent,
  parseMarkers,
  parsePs,
  type Marker,
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
// The rows only, every asked pane owned by this minmux.
const attribute = (
  snap: Snapshot,
  markers: Map<number, Marker>,
  ps: { paneId: string; shellPid: number }[],
  uid: number,
  names: ReadonlySet<string>,
) => attributeAll(snap, markers, ps, uid, names, new Set(ps.map((p) => p.paneId))).rows

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

describe("parseMarkers with the snapshot", () => {
  it("reads marks from the environment only, never from a command's arguments", () => {
    const snap = parsePs(
      [row(50, 1, "watch grep MINMUX_AGENT=claude"), row(51, 1, "node app.js")].join("\n"),
    )
    const env = [
      "   50 watch grep MINMUX_AGENT=claude HOME=/h", // the mark only in its arguments
      "   51 node app.js MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude HOME=/h",
      "   52 started-meanwhile MINMUX_AGENT=claude", // not in the snapshot: can't be split
    ].join("\n")
    expect(parseMarkers(env, snap)).toEqual(new Map([[51, { pane: "pane-A", agent: "claude" }]]))
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

  it("an agent marked by minmux's wrapper is one whatever its program", () => {
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
    // The pane's agent ended (none in its tree): left running.
    const { leftovers } = attributeAll(
      parsePs(ps),
      parseMarkers(env),
      [panes[0]!],
      UID,
      NAMES,
      new Set(["pane-A"]),
    )
    expect((leftovers["pane-A"] ?? []).map((p) => `${"·".repeat(p.depth)}${p.pid}`)).toEqual([
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

  it("an agent started outside the wrapper, under another program, is found by its command", () => {
    // `/usr/bin/time claude`: no mark (the wrapper function isn't used), a process in between.
    const ps = [
      row(1, 0, "/sbin/launchd", { uid: 0 }),
      row(100, 1, "/bin/zsh"),
      row(105, 100, "/usr/bin/time claude"),
      row(110, 105, "claude"),
      row(120, 110, "pytest"),
    ].join("\n")
    const r = attribute(parsePs(ps), new Map(), [panes[0]!], UID, NAMES)
    expect((r["pane-A"] ?? []).map((p) => `${p.depth}:${p.pid}`)).toEqual(["0:120"])
  })

  it("a launcher chain between the agent and its real binary isn't listed (Volta, a wrapper script)", () => {
    const ps = [
      row(1, 0, "/sbin/launchd", { uid: 0 }),
      row(100, 1, "/bin/zsh"),
      row(900, 100, "/h/.volta/bin/codex"),
      row(901, 900, "node /h/.volta/tools/codex.js"),
      row(902, 901, "/h/.volta/tools/vendor/codex"),
      row(903, 902, "cargo test"),
    ].join("\n")
    const env = ["  900 /h/.volta/bin/codex MINMUX_PANE_ID=pane-A MINMUX_AGENT=codex"].join("\n")
    const r = attribute(parsePs(ps), parseMarkers(env), [panes[0]!], UID, NAMES)
    expect((r["pane-A"] ?? []).map((p) => `${p.depth}:${p.pid}`)).toEqual(["0:903"])
  })

  it("a detached agent (a claude run inside a tmux from the pane) isn't a row: what it runs is", () => {
    const ps = [
      row(1, 0, "/sbin/launchd", { uid: 0 }),
      row(100, 1, "/bin/zsh"),
      row(700, 1, "claude"),
      row(701, 700, "npm test"),
    ].join("\n")
    const env = [
      "  700 claude MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude",
      "  701 npm test MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude",
    ].join("\n")
    const r = attribute(parsePs(ps), parseMarkers(env), [panes[0]!], UID, NAMES)
    expect((r["pane-A"] ?? []).map((p) => `${p.depth}:${p.pid}${p.detached ? "d" : ""}`)).toEqual([
      "0:701d",
    ])
  })

  it("a pane whose shell is gone: nothing", () => {
    const r = attribute(parsePs(PS), new Map(), [{ paneId: "x", shellPid: 999 }], UID, NAMES)
    expect(r).toEqual({ x: [] })
  })
})

describe("attributeAll: what was left running", () => {
  // Pane A's tree runs no agent any more: its detached server is left running; pane-gone was
  // closed (this minmux opened it); pane-other is another minmux's.
  const base = [
    row(1, 0, "/sbin/launchd", { uid: 0 }),
    row(100, 1, "/bin/zsh"),
    row(300, 1, "node server.js"),
    row(301, 300, "node worker.js"),
    row(310, 1, "node old.js"),
    row(320, 1, "node theirs.js"),
  ]
  const env = [
    "  300 node MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude",
    "  301 node MINMUX_PANE_ID=pane-A MINMUX_AGENT=claude",
    "  310 node MINMUX_PANE_ID=pane-gone MINMUX_AGENT=codex",
    "  320 node MINMUX_PANE_ID=pane-other MINMUX_AGENT=claude",
  ].join("\n")
  const run = (ps: string[]) =>
    attributeAll(
      parsePs(ps.join("\n")),
      parseMarkers(env),
      [panes[0]!],
      UID,
      NAMES,
      new Set(["pane-A", "pane-gone"]),
    )
  const ids = (l?: { pid: number; depth: number }[]) => (l ?? []).map((p) => `${p.depth}:${p.pid}`)

  it("a pane whose agent ended, and a closed pane this minmux opened: left running", () => {
    const { rows, leftovers } = run(base)
    expect(ids(leftovers["pane-A"])).toEqual(["0:300", "1:301"])
    expect(ids(leftovers["pane-gone"])).toEqual(["0:310"])
    expect(rows["pane-A"]).toEqual([])
  })

  it("another minmux's pane: never listed by this one", () => {
    const { rows, leftovers } = run(base)
    expect(JSON.stringify({ rows, leftovers })).not.toContain('"pid":320')
  })

  it("a pane whose agent detached (a claude in a tmux) and still runs: listed under it", () => {
    const ps = [...base, row(700, 1, "claude")]
    const marks = new Map(parseMarkers(env)).set(700, { pane: "pane-A", agent: "claude" })
    const { rows, leftovers } = attributeAll(
      parsePs(ps.join("\n")),
      marks,
      [panes[0]!],
      UID,
      NAMES,
      new Set(["pane-A"]),
    )
    expect(ids(rows["pane-A"])).toEqual(["0:300", "1:301"])
    expect(leftovers["pane-A"]).toBeUndefined()
  })

  it("a detached agent run by an interpreter (node …/bin/claude): still running, never a row", () => {
    const ps = [...base, row(700, 1, "node /opt/homebrew/bin/claude")]
    const marks = new Map(parseMarkers(env)).set(700, { pane: "pane-A", agent: "claude" })
    const { rows, leftovers } = attributeAll(
      parsePs(ps.join("\n")),
      marks,
      [panes[0]!],
      UID,
      NAMES,
      new Set(["pane-A"]),
    )
    expect(ids(rows["pane-A"])).toEqual(["0:300", "1:301"])
    expect(JSON.stringify(leftovers)).not.toContain('"pid":700')
  })

  it("looksLikeAgent: the program or the script it runs, not an unrelated node", () => {
    const p = (command: string) => parsePs(row(5, 1, command)).get(5)!
    expect(looksLikeAgent(p("/usr/local/bin/claude --resume"), NAMES)).toBe(true)
    expect(looksLikeAgent(p("node /usr/local/bin/codex"), NAMES)).toBe(true)
    expect(looksLikeAgent(p("node server.js"), NAMES)).toBe(false)
    expect(looksLikeAgent(p("npm run dev"), NAMES)).toBe(false)
    // Flags before it (one with a path value too); a log or folder named for an agent isn't one.
    expect(looksLikeAgent(p("node --require /x/preload.js /opt/homebrew/bin/claude"), NAMES)).toBe(
      true,
    )
    expect(looksLikeAgent(p("bun run --smol /x/bin/opencode"), NAMES)).toBe(true)
    expect(looksLikeAgent(p("tail -f /Users/me/.codex/log/codex-tui.log"), NAMES)).toBe(false)
    expect(looksLikeAgent(p("grep -rn claude src"), NAMES)).toBe(false)
    expect(looksLikeAgent(p("vim /Users/me/src/codex"), NAMES)).toBe(false) // only an interpreter's script
    expect(looksLikeAgent(p("node /Users/me/opencode/node_modules/.bin/vite"), NAMES)).toBe(false)
  })

  it("a detached agent under a script is never a row; what the script runs is", () => {
    const ps = [
      ...base,
      row(400, 1, "bash run-agents.sh"),
      row(401, 400, "-zsh"),
      row(402, 401, "node /x/claude-code/cli.js"),
      row(403, 400, "-zsh"),
    ]
    const marks = new Map(parseMarkers(env))
      .set(400, { pane: "pane-A", agent: "claude" })
      .set(402, { pane: "pane-A", agent: "claude" })
    const { rows } = attributeAll(
      parsePs(ps.join("\n")),
      marks,
      [panes[0]!],
      UID,
      NAMES,
      new Set(["pane-A"]),
    )
    const r = rows["pane-A"]!
    expect(r.map((p) => p.pid)).not.toContain(402) // the agent itself is never a row
  })

  it("a closed pane whose detached agent still runs: its work is left running (no list shows it)", () => {
    const ps = [...base, row(700, 1, "claude")]
    const marks = new Map(parseMarkers(env)).set(700, { pane: "pane-gone", agent: "codex" })
    const { leftovers } = attributeAll(
      parsePs(ps.join("\n")),
      marks,
      [panes[0]!],
      UID,
      NAMES,
      new Set(["pane-A", "pane-gone"]),
    )
    expect(ids(leftovers["pane-gone"])).toEqual(["0:310"])
  })

  it("rows only for the open panes; the others still count as running", () => {
    const ps = [...base, row(110, 100, "claude"), row(111, 110, "npm test")]
    const { rows, leftovers } = attributeAll(
      parsePs(ps.join("\n")),
      parseMarkers(env),
      [panes[0]!],
      UID,
      NAMES,
      new Set(["pane-A"]),
      new Set(),
    )
    expect(rows["pane-A"]).toEqual([])
    expect(leftovers["pane-A"]).toBeUndefined()
  })

  it("a pane whose tree still runs an agent (hooks or not): listed under it, not left running", () => {
    const { rows, leftovers } = run([...base, row(110, 100, "claude")])
    expect(ids(rows["pane-A"])).toEqual(["0:300", "1:301"])
    expect(leftovers["pane-A"]).toBeUndefined()
  })
})

describe("parseLsof", () => {
  it("maps each pid to the TCP ports it listens on, sorted, once each", () => {
    const out = [
      "p80809",
      "f27",
      "n[::1]:5203",
      "f28",
      "n*:5173",
      "f29",
      "n127.0.0.1:5173",
      "p80885",
      "f25",
      "n[::1]:5206",
      "nweird",
    ].join("\n")
    expect(parseLsof(out)).toEqual(
      new Map([
        [80809, [5173, 5203]],
        [80885, [5206]],
      ]),
    )
    expect(parseLsof("")).toEqual(new Map())
  })
})
