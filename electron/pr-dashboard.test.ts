import { describe, expect, it, vi } from "vitest"
import { ghError, PrDashboard, repoFromRemotes, type PrRunner } from "./pr-dashboard"

const answer = JSON.stringify({
  data: { mine: { nodes: [] }, review: { nodes: [] }, repo: { nodes: [] } },
})

describe("repoFromRemotes", () => {
  it("upstream first (a fork's PRs live there), then origin, then any GitHub remote", () => {
    const out = [
      "origin\tgit@github.com:me/r.git (fetch)",
      "upstream\thttps://github.com/o/r.git (fetch)",
    ].join("\n")
    expect(repoFromRemotes(out)).toBe("o/r")
    expect(repoFromRemotes("origin\tgit@github.com:me/r.git (fetch)")).toBe("me/r")
    expect(
      repoFromRemotes("lab\tgit@gitlab.com:o/r.git (fetch)\nhub\tgit@github.com:o/h (fetch)"),
    ).toBe("o/h")
    expect(repoFromRemotes("")).toBeNull()
  })
})

describe("ghError", () => {
  it("not installed, logged out, offline, anything else", () => {
    expect(ghError({ code: "ENOENT" })).toEqual({ error: "missing" })
    expect(ghError({ code: 127 })).toEqual({ error: "missing" })
    expect(ghError({ code: 4 })).toEqual({ error: "unauthenticated" })
    expect(
      ghError({ code: 1, stderr: "error connecting to api.github.com\ndial tcp: lookup" }),
    ).toEqual({
      error: "offline",
    })
    expect(ghError({ killed: true })).toEqual({ error: "offline" })
    expect(ghError({ code: 1, stderr: "\nGraphQL: Something went wrong\n" })).toEqual({
      error: "failed",
      message: "GraphQL: Something went wrong",
    })
  })
})

describe("PrDashboard", () => {
  const runner = () =>
    vi.fn<PrRunner>(async (cmd) =>
      cmd === "git" ? "origin\tgit@github.com:o/r.git (fetch)\n" : answer,
    )

  it("the focused checkout's repo is the repo tab; gh runs there, in its environment", async () => {
    const run = runner()
    const res = await new PrDashboard(run).lists({
      cwd: "/w/r",
      wsl: { distro: "U" },
      closed: false,
    })
    expect(res).toEqual({ ok: true, lists: { mine: [], review: [], repo: [], repoName: "o/r" } })
    const [cmd, args, cwd, wsl] = run.mock.calls[1]!
    expect([cmd, cwd, wsl]).toEqual(["gh", "/w/r", { distro: "U" }])
    expect(args).toContain("repo=is:pr is:open repo:o/r sort:updated-desc")
    expect(args).toContain("withRepo=true")
    expect(args.find((a) => a.startsWith("query="))).not.toContain("\n") // one line
  })

  it("no checkout (an ssh pane), or no GitHub remote: no repo tab", async () => {
    const run = vi.fn<PrRunner>(async (cmd) => (cmd === "git" ? "" : answer))
    const d = new PrDashboard(run)
    expect(await d.lists({ closed: false })).toEqual({ ok: true, lists: { mine: [], review: [] } })
    expect(run.mock.calls.every(([cmd]) => cmd === "gh")).toBe(true)
    await d.lists({ cwd: "/w/x", closed: false })
    expect(run.mock.calls.at(-1)![1]).toContain("withRepo=false")
  })

  it("a checkout's repo is cached; one query in flight at a time", async () => {
    const run = runner()
    const d = new PrDashboard(run)
    const [a, b] = [
      d.lists({ cwd: "/w/r", closed: false }),
      d.lists({ cwd: "/w/r", closed: false }),
    ]
    expect(await a).toBe(await b)
    await d.lists({ cwd: "/w/r", closed: false })
    expect(run.mock.calls.filter(([cmd]) => cmd === "git")).toHaveLength(1)
  })

  it("gh's failures are answers, never throws", async () => {
    const run = vi.fn<PrRunner>(async (cmd) => {
      if (cmd === "git") return ""
      throw Object.assign(new Error("x"), { code: 4 })
    })
    expect(await new PrDashboard(run).lists({ closed: false })).toEqual({
      ok: false,
      error: "unauthenticated",
    })
    const garbled = vi.fn<PrRunner>(async () => "not json")
    expect(await new PrDashboard(garbled).lists({ closed: false })).toMatchObject({ ok: false })
  })
})
