import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { normalizeClaudeEvent } from "./claude"
import { normalizeCodexEvent } from "./codex"
import { normalizeOpencodeDrop } from "./opencode"
import { OPENCODE_DROP_VERSION, OPENCODE_PLUGIN } from "./opencode-plugin"
import { CD_PREFIX, cdPrefix, workedFolders } from "./worked"

describe("cdPrefix", () => {
  it("takes the one shape agents use: cd <absolute path> &&", () => {
    expect(cdPrefix("cd /Users/me/rts-track-e && git commit -m x")).toBe("/Users/me/rts-track-e")
    expect(cdPrefix("cd /a/b/ && ls")).toBe("/a/b/")
    expect(cdPrefix("cd  /a&&ls")).toBe("/a")
  })

  it("ignores anything else", () => {
    for (const c of [
      "cd rel && ls", // relative
      'cd "/a b" && ls', // quoted
      "cd $HOME/x && ls",
      "cd ~/x && ls",
      "cd /a; ls",
      "cd /a || ls",
      "cd /a",
      "ls && cd /a && ls", // not first
      "cd /a`x` && ls",
      "cd /a/* && ls",
      " cd /a && ls",
    ])
      expect(cdPrefix(c), c).toBeUndefined()
    expect(cdPrefix(42)).toBeUndefined()
  })

  it("the OpenCode plugin carries the same pattern", () => {
    const line = OPENCODE_PLUGIN.split("\n").find((l) => l.startsWith("const CD_PREFIX = "))
    expect(line).toBe(`const CD_PREFIX = ${CD_PREFIX.toString()}`)
  })
})

describe("workedFolders", () => {
  it("files give their folders; dirs stay; deduped", () => {
    expect(workedFolders(["/r/a/x.ts", "/r/a/y.ts", "/r/b.ts"], undefined, ["/s/"])).toEqual([
      "/r/a",
      "/r",
      "/s",
    ])
  })

  it("resolves relative paths against the cwd, else drops them", () => {
    expect(workedFolders(["src/a.ts", "../o/b.ts"], "/r/app")).toEqual(["/r/app/src", "/r/o"])
    expect(workedFolders(["src/a.ts"], undefined)).toBeUndefined()
    expect(workedFolders(["src/a.ts"], "rel")).toBeUndefined()
  })

  it("Windows paths keep Windows rules; POSIX ones POSIX rules", () => {
    expect(workedFolders(["C:\\r\\a\\x.ts"], undefined)).toEqual(["C:\\r\\a"])
    expect(workedFolders(["x.ts"], "C:\\r")).toEqual(["C:\\r"])
    expect(workedFolders(["/home/me/r/x.ts"], "C:\\r")).toEqual(["/home/me/r"])
  })

  it("leaves out the agents' own folders, temp and dependency folders", () => {
    for (const f of [
      "/Users/me/.claude/projects/x/memory/a.md",
      "/home/me/.codex/x.json",
      "/home/me/.config/opencode/a.json",
      "C:\\Users\\me\\.claude\\a.md",
      "/tmp/x/a.ts",
      "/private/tmp/a.ts",
      "/var/folders/ab/T/a.ts",
      "/r/node_modules/p/a.js",
      "/r/.git/hooks/pre-commit",
    ])
      expect(workedFolders([f], undefined), f).toBeUndefined()
    // This machine's home, whatever its layout.
    expect(workedFolders([path.join(os.homedir(), ".claude", "plans", "a.md")], undefined)).toBe(
      undefined,
    )
    // Codex's own worktrees are checkouts.
    expect(workedFolders(["/Users/me/.codex/worktrees/ab/r/a.ts"], undefined)).toEqual([
      "/Users/me/.codex/worktrees/ab/r",
    ])
    // A repo's own `.claude` folder is work in that repo.
    expect(workedFolders(["/Users/me/r/.claude/skills/a.md"], undefined)).toEqual([
      "/Users/me/r/.claude/skills",
    ])
  })

  it("is bounded", () => {
    const files = Array.from({ length: 100 }, (_, i) => `/r/d${i}/a.ts`)
    expect(workedFolders(files, undefined)).toHaveLength(32)
  })
})

const claude = (over: Record<string, unknown>) =>
  normalizeClaudeEvent({
    hook_event_name: "PostToolUse",
    session_id: "s",
    cwd: "/Users/me/rts",
    ...over,
  })

describe("Claude: where a call worked", () => {
  it("a finished edit: its file's folder", () => {
    for (const tool_name of ["Edit", "Write", "MultiEdit"])
      expect(
        claude({ tool_name, tool_input: { file_path: "/Users/me/rts-e/docs/a.md" } })?.worked,
      ).toEqual(["/Users/me/rts-e/docs"])
    expect(
      claude({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/n/a.ipynb" } })?.worked,
    ).toEqual(["/n"])
  })

  it("a Bash call starting cd <abs> &&", () => {
    const ev = claude({
      tool_name: "Bash",
      tool_input: { command: "cd /Users/me/rts-e && git commit -m 'x'" },
    })
    expect(ev?.worked).toEqual(["/Users/me/rts-e"])
    expect(claude({ tool_name: "Bash", tool_input: { command: "git status" } })?.worked).toBe(
      undefined,
    )
  })

  it("never a read, never before the call ran", () => {
    expect(claude({ tool_name: "Read", tool_input: { file_path: "/o/a.ts" } })?.worked).toBe(
      undefined,
    )
    const pre = claude({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/o/a.ts" },
    })
    expect(pre?.worked).toBeUndefined()
    expect(pre?.filePath).toBe("/o/a.ts")
  })
})

describe("Codex: where a call worked", () => {
  const codex = (over: Record<string, unknown>) =>
    normalizeCodexEvent({ hook_event_name: "PostToolUse", session_id: "s", cwd: "/r", ...over })

  it("every file a patch touches, moves included; relative ones from the cwd", () => {
    const command =
      "*** Begin Patch\n*** Update File: /o/a.ts\n@@\n-x\n*** Add File: src/b.ts\n+y\n" +
      "*** Update File: /o/c.ts\n*** Move to: /p/c.ts\n*** End Patch"
    const ev = codex({ tool_name: "apply_patch", tool_input: { command } })
    expect(ev?.filePath).toBe("/o/a.ts")
    expect(ev?.worked).toEqual(["/o", "/r/src", "/p"])
  })

  it("a shell call starting cd <abs> &&", () => {
    expect(codex({ tool_name: "Bash", tool_input: { command: "cd /w && make" } })?.worked).toEqual([
      "/w",
    ])
  })

  it("a shell call's absolute workdir, or the script of an argv command", () => {
    expect(
      codex({ tool_name: "exec_command", tool_input: { cmd: "ls", workdir: "/w" } })?.worked,
    ).toEqual(["/w"])
    expect(
      codex({ tool_name: "shell", tool_input: { command: ["bash", "-lc", "cd /v && make"] } })
        ?.worked,
    ).toEqual(["/v"])
    expect(
      codex({ tool_name: "shell", tool_input: { command: "ls", workdir: "rel" } })?.worked,
    ).toBeUndefined()
  })

  it("Claude's edit tool names mean nothing here; nor does a PreToolUse", () => {
    expect(codex({ tool_name: "Write", tool_input: { file_path: "/o/a.ts" } })?.worked).toBe(
      undefined,
    )
    const pre = codex({
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Add File: /o/a.ts\n" },
    })
    expect(pre?.worked).toBeUndefined()
  })
})

describe("OpenCode: where a call worked", () => {
  const drop = (over: Record<string, unknown>) =>
    normalizeOpencodeDrop(
      {
        v: OPENCODE_DROP_VERSION,
        e: "tool",
        phase: "end",
        sessionID: "ses_a",
        directory: "/r",
        ...over,
      },
      "p1",
    )

  it("an edit tool's paths, at its end", () => {
    expect(drop({ tool: "write", paths: ["/o/a.ts", "b/c.ts"] })?.worked).toEqual(["/o", "/r/b"])
    expect(drop({ tool: "edit", paths: ["/o/a.ts"], phase: "start" })?.worked).toBeUndefined()
  })

  it("a read's path is not work there", () => {
    expect(drop({ tool: "read", paths: ["/o/a.ts"] })?.worked).toBeUndefined()
  })

  it("a bash call's folder", () => {
    expect(drop({ tool: "bash", workDir: "/w" })?.worked).toEqual(["/w"])
    expect(drop({ tool: "bash", workDir: "rel" })?.worked).toBeUndefined()
    expect(drop({ tool: "write", workDir: "/w" })?.worked).toBeUndefined()
  })
})
