import { describe, expect, it, vi } from "vitest"
import { ghError, PrDashboard, repoFromRemotes, type PrRunner } from "./pr-dashboard"
import { wslArgs } from "./git"

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
      ghError({ code: 1, stderr: "<3>WSL (1) ERROR: execvpe(gh) failed: No such file" }),
    ).toEqual({
      error: "missing",
    })
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
    const res = await new PrDashboard(run, Date.now, async () => false).lists({
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
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.lists({ closed: false })).toEqual({ ok: true, lists: { mine: [], review: [] } })
    expect(run.mock.calls.every(([cmd]) => cmd === "gh")).toBe(true)
    await d.lists({ cwd: "/w/x", closed: false })
    expect(run.mock.calls.at(-1)![1]).toContain("withRepo=false")
  })

  it("WSL: gh runs without the distro's shell (the query's $vars reach it as they are)", () => {
    expect(wslArgs("U", "/w", "gh", ["-f", "query=query($n: Int!)"], true)).toEqual([
      "-d",
      "U",
      "--cd",
      "/w",
      "-e",
      "gh",
      "-f",
      "query=query($n: Int!)",
    ])
  })

  it("a folder that's gone: gh runs from home, never 'gh isn't installed'", async () => {
    const run = runner()
    const d = new PrDashboard(run, Date.now, async () => false)
    expect((await d.lists({ cwd: "/gone", closed: false })).ok).toBe(true)
    expect(run.mock.calls.map(([cmd, , cwd]) => [cmd, cwd === "/gone"])).toEqual([["gh", false]])
  })

  it("one search failing: the others' answers show, with a note", async () => {
    const run = vi.fn<PrRunner>(async (cmd) => {
      if (cmd === "git") return "origin\tgit@github.com:o/private.git (fetch)\n"
      throw Object.assign(new Error("x"), {
        code: 1,
        stdout: JSON.stringify({
          data: { mine: { nodes: [] }, review: { nodes: [] }, repo: null },
        }),
        stderr: "GraphQL: The listed users and repositories cannot be searched",
      })
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.lists({ cwd: "/w", closed: false })).toEqual({
      ok: true,
      lists: {
        mine: [],
        review: [],
        repo: [],
        repoName: "o/private",
        warning: "GraphQL: The listed users and repositories cannot be searched",
      },
    })
  })

  it("different requests never share an answer", async () => {
    const run = runner()
    const d = new PrDashboard(run, Date.now, async () => true)
    await Promise.all([
      d.lists({ cwd: "/w/r", closed: false }),
      d.lists({ cwd: "/w/r", closed: true }),
    ])
    expect(run.mock.calls.filter(([cmd]) => cmd === "gh")).toHaveLength(2)
  })

  it("a checkout's repo is cached; one query in flight at a time", async () => {
    const run = runner()
    const d = new PrDashboard(run, Date.now, async () => true)
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
    expect(await new PrDashboard(run, Date.now, async () => true).lists({ closed: false })).toEqual(
      {
        ok: false,
        error: "unauthenticated",
      },
    )
    const garbled = vi.fn<PrRunner>(async () => "not json")
    expect(await new PrDashboard(garbled).lists({ closed: false })).toMatchObject({ ok: false })
  })
})

describe("PrDashboard.detail", () => {
  const detail = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          url: "https://github.com/o/r/pull/7",
          updatedAt: "t",
          body: "b",
          reviews: { nodes: [] },
          comments: { nodes: [] },
          reviewThreads: { nodes: [] },
        },
      },
    },
  })

  it("asks for that PR by owner, name and number, from the pane's folder", async () => {
    const run = vi.fn<PrRunner>(async () => detail)
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.detail({ repo: "o/r", number: 7, cwd: "/w" })
    expect(res).toMatchObject({ ok: true, detail: { url: "https://github.com/o/r/pull/7" } })
    const [cmd, args, cwd] = run.mock.calls[0]!
    expect([cmd, cwd]).toEqual(["gh", "/w"])
    expect(args).toEqual(expect.arrayContaining(["owner=o", "name=r", "number=7"]))
  })

  it("not a repo name: no gh run; gh's failures are answers", async () => {
    const run = vi.fn<PrRunner>(async () => {
      throw Object.assign(new Error("x"), { code: "ENOENT" })
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.detail({ repo: "nope", number: 1 })).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
    expect(await d.detail({ repo: "o/r", number: 1 })).toEqual({ ok: false, error: "missing" })
  })

  it("moving through PRs: the ones passed over are skipped, only the newest runs next", async () => {
    let release: () => void = () => {}
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args.includes("number=1")) await new Promise<void>((r) => (release = r))
      return detail
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    const a = d.detail({ repo: "o/r", number: 1 })
    const b = d.detail({ repo: "o/r", number: 2 })
    const c = d.detail({ repo: "o/r", number: 3 })
    expect(await b).toMatchObject({ ok: false, message: "Superseded" })
    release()
    expect((await a).ok).toBe(true)
    expect((await c).ok).toBe(true)
    const asked = run.mock.calls.map(([, args]) => args.find((x) => x.startsWith("number=")))
    expect(asked).toEqual(["number=1", "number=3"])
  })
})
