import { describe, expect, it, vi } from "vitest"
import {
  ghError,
  parseAccounts,
  PrDashboard,
  repoFromRemotes,
  repoOrder,
  tokenEnv,
  unclearFailure,
  type PrRunner,
} from "./pr-dashboard"
import { wslArgs } from "./git"

const answer = JSON.stringify({
  data: { mine: { nodes: [] }, review: { nodes: [] }, repo: { nodes: [] }, visible: { id: "R" } },
})
// gh's own calls (`gh auth status` asked first is gh's accounts: none here, an old gh)
const queries = (run: { mock: { calls: Parameters<PrRunner>[] } }) =>
  run.mock.calls.filter(([cmd, args]) => cmd === "gh" && args[0] === "api")

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
    expect(res).toEqual({
      ok: true,
      lists: { mine: [], review: [], repo: [], repoName: "o/r", repoVisible: true, accounts: [] },
    })
    const [cmd, args, cwd, wsl] = queries(run)[0]!
    expect([cmd, cwd, wsl]).toEqual(["gh", "/w/r", { distro: "U" }])
    expect(args).toContain("repo=is:pr is:open repo:o/r sort:updated-desc")
    expect(args).toContain("withRepo=true")
    expect(args.find((a) => a.startsWith("query="))).not.toContain("\n") // one line
  })

  it("no checkout (an ssh pane), or no GitHub remote: no repo tab", async () => {
    const run = vi.fn<PrRunner>(async (cmd) => (cmd === "git" ? "" : answer))
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.lists({ closed: false })).toEqual({
      ok: true,
      lists: { mine: [], review: [], accounts: [] },
    })
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
    expect(run.mock.calls.map(([cmd, , cwd]) => [cmd, cwd === "/gone"])).toEqual([
      ["gh", false],
      ["gh", false],
    ])
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
        repoVisible: false, // said by the empty repo tab, not as a note
        accounts: [],
      },
    })
  })

  it("an error that isn't the repo being unseen is the note", async () => {
    const run = vi.fn<PrRunner>(async (cmd) => {
      if (cmd === "git") return "origin\tgit@github.com:o/r.git (fetch)\n"
      throw Object.assign(new Error("x"), {
        code: 1,
        stdout: JSON.stringify({
          data: { mine: null, review: { nodes: [] }, repo: { nodes: [] }, visible: null },
        }),
        stderr: "gh: Could not resolve to a Repository with the name 'o/r'.\nSomething else broke",
      })
    })
    const res = await new PrDashboard(run, Date.now, async () => true).lists({
      cwd: "/w",
      closed: false,
    })
    expect(res).toMatchObject({ ok: true, lists: { warning: "Something else broke" } })
  })

  it("different requests never share an answer", async () => {
    const run = runner()
    const d = new PrDashboard(run, Date.now, async () => true)
    await Promise.all([
      d.lists({ cwd: "/w/r", closed: false }),
      d.lists({ cwd: "/w/r", closed: true }),
    ])
    expect(queries(run)).toHaveLength(2)
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
      { ok: false, error: "unauthenticated", accounts: [] },
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
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    release()
    expect((await a).ok).toBe(true)
    expect((await c).ok).toBe(true)
    const asked = run.mock.calls.map(([, args]) => args.find((x) => x.startsWith("number=")))
    expect(asked).toEqual(["number=1", "number=3"])
  })
})

describe("PrDashboard.candidates", () => {
  const candidates = (teams: boolean) =>
    JSON.stringify({
      data: {
        repository: { assignableUsers: { nodes: [{ login: "ann" }] } },
        ...(teams ? { repositoryOwner: { __typename: "Organization", teams: { nodes: [] } } } : {}),
      },
    })

  it("suggestions only for an empty search; the search text reaches gh as it is", async () => {
    const run = vi.fn<PrRunner>(async () => candidates(true))
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.candidates({ repo: "o/r", number: 7, query: "" })).toMatchObject({
      ok: true,
      candidates: { people: [{ login: "ann" }], teams: [] },
    })
    expect(run.mock.calls[0]![1]).toEqual(
      expect.arrayContaining(["q=", "suggest=true", "teams=true", "number=7"]),
    )
    await d.candidates({ repo: "o/r", number: 7, query: " a b " })
    expect(run.mock.calls[1]![1]).toEqual(expect.arrayContaining(["q=a b", "suggest=false"]))
  })

  it("no read:org: asked again without teams, with the hint; not tried again for a while", async () => {
    let now = 0
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args.includes("teams=true"))
        throw Object.assign(new Error("x"), {
          code: 1,
          stderr: "GraphQL: The 'teams' field requires one of the following scopes: ['read:org']",
        })
      return candidates(false)
    })
    const d = new PrDashboard(
      run,
      () => now,
      async () => true,
    )
    const req = { repo: "o/r", number: 7, query: "" }
    expect(await d.candidates(req)).toMatchObject({ ok: true, candidates: { teams: "no-scope" } })
    await d.candidates(req)
    expect(run).toHaveBeenCalledTimes(3) // teams=true, teams=false, then teams=false only
    now = 11 * 60_000
    await d.candidates(req)
    expect(run.mock.calls[3]![1]).toContain("teams=true")
  })

  it("no read:org: gh's partial answer is used; only that owner's teams are skipped", async () => {
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args.includes("teams=true") && args.includes("owner=org"))
        throw Object.assign(new Error("x"), {
          code: 1,
          stderr: "requires one of the following scopes: ['read:org']",
          stdout: candidates(false),
        })
      return JSON.stringify({
        data: {
          repository: { assignableUsers: { nodes: [] } },
          repositoryOwner: { __typename: "User" },
        },
      })
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.candidates({ repo: "org/r", number: 7, query: "" })).toMatchObject({
      ok: true,
      candidates: { people: [{ login: "ann" }], teams: "no-scope" },
    })
    expect(run).toHaveBeenCalledTimes(1)
    expect(await d.candidates({ repo: "me/r", number: 7, query: "" })).toMatchObject({
      ok: true,
      candidates: { teams: null },
    })
    expect(run.mock.calls[1]![1]).toContain("teams=true")
  })

  it("a run that throws outside gh is an answer, never a hang", async () => {
    const d = new PrDashboard(vi.fn<PrRunner>(), Date.now, async () => {
      throw new Error("fs")
    })
    expect(await d.candidates({ repo: "o/r", number: 7, query: "", cwd: "/w" })).toMatchObject({
      ok: false,
    })
  })

  it("typing: the searches passed over are skipped", async () => {
    let release: () => void = () => {}
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args.includes("q=a")) await new Promise<void>((r) => (release = r))
      return candidates(true)
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    const a = d.candidates({ repo: "o/r", number: 7, query: "a" })
    const b = d.candidates({ repo: "o/r", number: 7, query: "an" })
    const c = d.candidates({ repo: "o/r", number: 7, query: "ann" })
    expect(await b).toMatchObject({ ok: false, message: "Superseded" })
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    release()
    expect((await a).ok).toBe(true)
    expect((await c).ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe("PrDashboard.reviewers", () => {
  const rowAnswer = JSON.stringify({
    data: { repository: { pullRequest: { number: 7, url: "u", state: "OPEN" } } },
  })

  it("gh pr edit, then the PR's row fetched again", async () => {
    const run = vi.fn<PrRunner>(async (_cmd, args) => (args[0] === "pr" ? "" : rowAnswer))
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.reviewers({ repo: "o/r", number: 7, add: ["ann"], remove: [], cwd: "/w" })
    expect(res).toMatchObject({ ok: true, row: { number: 7, url: "u" } })
    expect(run.mock.calls[0]).toEqual([
      "gh",
      ["pr", "edit", "7", "--repo", "o/r", "--add-reviewer", "ann"],
      "/w",
      undefined,
      undefined,
    ])
  })

  it("not a reviewer: no gh run; the edit failing is the answer; the refetch failing isn't", async () => {
    const run = vi.fn<PrRunner>(async () => {
      throw Object.assign(new Error("x"), { code: 1, stderr: "could not request reviewer" })
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(
      await d.reviewers({ repo: "o/r", number: 7, add: ["--repo=x/y"], remove: [] }),
    ).toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
    expect(await d.reviewers({ repo: "o/r", number: 7, add: ["ann"], remove: [] })).toEqual({
      ok: false,
      error: "failed",
      message: "could not request reviewer",
    })
    run.mockImplementation(async (_cmd, args) => {
      if (args[0] === "pr") return ""
      throw new Error("offline")
    })
    expect(await d.reviewers({ repo: "o/r", number: 7, add: ["ann"], remove: [] })).toEqual({
      ok: true,
      row: null,
    })
  })
})

describe("PrDashboard.reviewers read:org", () => {
  it("gh refusing for want of read:org: says how to grant it", async () => {
    const run = vi.fn<PrRunner>(async () => {
      throw Object.assign(new Error("x"), {
        code: 1,
        stderr: "error fetching organization teams: requires the ['read:org'] scope",
      })
    })
    const res = await new PrDashboard(run, Date.now, async () => true).reviewers({
      repo: "o/r",
      number: 7,
      add: ["ann"],
      remove: [],
    })
    expect(res).toMatchObject({ ok: false, message: expect.stringMatching(/gh auth refresh/) })
  })
})

describe("several gh accounts", () => {
  const status = JSON.stringify({
    hosts: {
      "github.com": [
        { login: "me", active: true, state: "success", token: "never-read" },
        { login: "work", active: false, state: "success" },
      ],
      "ghe.example.com": [{ login: "other", active: true, state: "success" }],
    },
  })
  const node = (n: number, repo = "o/r") => ({
    number: n,
    url: `https://github.com/${repo}/pull/${n}`,
    state: "OPEN",
    repository: { nameWithOwner: repo },
  })
  // `me` sees no o/r; `work` does. Both list one shared PR.
  const asWork = JSON.stringify({
    data: {
      mine: { nodes: [node(1), node(9, "x/y")] },
      review: { nodes: [] },
      repo: { nodes: [node(1), node(2)] },
      visible: { id: "R" },
    },
  })
  const asMe = JSON.stringify({
    data: {
      mine: { nodes: [node(5, "me/p"), node(9, "x/y")] },
      review: { nodes: [] },
      repo: { nodes: [] },
      visible: null,
    },
  })
  const runner = () =>
    vi.fn<PrRunner>(async (cmd, args, _cwd, _wsl, token) => {
      if (cmd === "git") return "origin\tgit@github.com:o/r.git (fetch)\n"
      if (args[0] === "auth" && args[1] === "status") return status
      if (args[0] === "auth" && args[1] === "token") return `tok-${args.at(-1)}\n`
      if (token === "tok-work") return asWork
      if (token === "tok-me") return asMe
      throw new Error("ran as gh's active account")
    })

  it("gh's accounts on github.com; never its tokens", () => {
    expect(parseAccounts(status)).toEqual([
      { login: "me", active: true, ok: true },
      { login: "work", active: false, ok: true },
    ])
    expect(parseAccounts("nope")).toEqual([])
    expect(JSON.stringify(parseAccounts(status))).not.toContain("never-read")
  })

  it("every account's lists, each PR once, tagged; the repo tab as the account that sees it", async () => {
    const run = runner()
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.lists({ cwd: "/w/r", closed: false })
    if (!res.ok) throw new Error("not ok")
    const l = res.lists
    expect(l.mine.map((r) => [r.number, r.account])).toEqual([
      [5, "me"],
      [9, "me"],
      [1, "work"],
    ])
    expect(l.repo!.map((r) => [r.number, r.account])).toEqual([
      [1, "work"],
      [2, "work"],
    ])
    expect([l.repoAccount, l.repoVisible, l.warning]).toEqual(["work", true, undefined])
    expect(l.accounts!.map((a) => a.login)).toEqual(["me", "work"])
    // gh's active account is never switched: each run carries its own token
    expect(run.mock.calls.some(([, args]) => args.includes("switch"))).toBe(false)
  })

  it("the repo is asked of one account; the next only when it can't see it, then remembered", async () => {
    const run = runner()
    const d = new PrDashboard(run, Date.now, async () => true)
    const repoAsks = () =>
      queries(run)
        .filter(([, args]) => args.includes("withRepo=true"))
        .map(([, , , , t]) => t)
    await d.lists({ cwd: "/w/r", closed: false })
    expect(repoAsks()).toEqual(["tok-me", "tok-work"]) // me (gh's active) first: it can't
    await d.lists({ cwd: "/w/r", closed: true })
    expect(repoAsks()).toEqual(["tok-me", "tok-work", "tok-work"]) // work first now, and only
  })

  it("one account picked: only its lists; the repo tab empty when it can't see the repo", async () => {
    const run = runner()
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.lists({ cwd: "/w/r", closed: false, account: "me" })
    if (!res.ok) throw new Error("not ok")
    expect(res.lists.mine.map((r) => r.number)).toEqual([5, 9])
    expect([res.lists.repo, res.lists.repoVisible]).toEqual([[], false])
    expect(queries(run).map(([, , , , token]) => token)).toEqual(["tok-me"])
  })

  it("the repo's account is tried first next time; a PR's own requests run as its account", async () => {
    expect(
      repoOrder(
        [
          { login: "a", active: false, ok: true },
          { login: "b", active: true, ok: true },
          { login: "c", active: false, ok: true },
        ],
        "c",
      ).map((a) => a.login),
    ).toEqual(["c", "b", "a"])
    const run = runner()
    const d = new PrDashboard(run, Date.now, async () => true)
    await d.detail({ repo: "o/r", number: 1, account: "work" }).catch(() => null)
    expect(queries(run).at(-1)![4]).toBe("tok-work")
    const before = queries(run).length
    // not logged in any more: refused, never run as gh's active account
    expect(await d.detail({ repo: "o/r", number: 2, account: "nobody" })).toMatchObject({
      ok: false,
      error: "unauthenticated",
      message: expect.stringContaining("@nobody isn't logged in"),
    })
    expect(queries(run)).toHaveLength(before)
  })

  it("GH_TOKEN for that run only; into WSL through WSLENV", () => {
    expect(tokenEnv({ A: "1" }, undefined, false)).toBeUndefined()
    expect(tokenEnv({ A: "1" }, "t", false)).toEqual({ A: "1", GH_TOKEN: "t" })
    expect(tokenEnv({ WSLENV: "X/p" }, "t", true)).toEqual({
      WSLENV: "X/p:GH_TOKEN",
      GH_TOKEN: "t",
    })
  })
})

describe("several gh accounts, failures", () => {
  const status = (state2: string) =>
    JSON.stringify({
      hosts: {
        "github.com": [
          { login: "me", active: true, state: "timeout" },
          { login: "work", active: false, state: state2 },
        ],
      },
    })

  it("offline isn't signed out; a bad token is", () => {
    expect(parseAccounts(status("error"))).toEqual([
      { login: "me", active: true, ok: true, offline: true },
      { login: "work", active: false, ok: false },
    ])
  })

  it("a failure keeps the accounts (the picker stays); a picked signed-out account: all", async () => {
    const run = vi.fn<PrRunner>(async (cmd, args) => {
      if (args[0] === "auth" && args[1] === "status") return status("error")
      if (args[0] === "auth") return "tok\n"
      throw Object.assign(new Error("x"), { code: 1, stderr: "dial tcp: lookup api.github.com" })
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.lists({ closed: false, account: "work" })
    expect(res).toMatchObject({ ok: false, error: "offline" })
    expect(!res.ok && res.accounts?.map((a) => a.login)).toEqual(["me", "work"])
    // the picked account is signed out: run as the others (me), not as it
    expect(
      run.mock.calls
        .filter(([, a]) => a[0] === "auth" && a[1] === "token")
        .map(([, a]) => a.at(-1)),
    ).toEqual(["me"])
  })

  it("an offline (or failed) answer is kept only briefly", async () => {
    let now = 0
    let fail = false
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (fail) throw new Error("killed")
      return args[1] === "status" ? status("success") : "{}"
    })
    const d = new PrDashboard(
      run,
      () => now,
      async () => true,
    )
    await d.accounts()
    now = 5_000
    await d.accounts()
    const asked = () => run.mock.calls.filter(([, a]) => a[1] === "status").length
    expect(asked()).toBe(1) // offline (me timed out): kept 10 s
    now = 11_000
    fail = true
    expect(await d.accounts()).toEqual([])
    now = 22_000
    fail = false
    await d.accounts()
    expect(asked()).toBe(3) // a failed run isn't kept for a minute either
  })
  it("a token gh refuses is forgotten; a PR's fresh row keeps its account", async () => {
    let refuse = true
    const rowAnswer = JSON.stringify({
      data: { repository: { pullRequest: { number: 7, url: "u", state: "OPEN" } } },
    })
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args[1] === "status")
        return JSON.stringify({
          hosts: {
            "github.com": [
              { login: "me", active: true, state: "success" },
              { login: "work", state: "success" },
            ],
          },
        })
      if (args[1] === "token") return "tok\n"
      if (args[0] === "pr" && refuse)
        throw Object.assign(new Error("x"), { code: 1, stderr: "HTTP 401: Bad credentials" })
      return rowAnswer
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    const req = { repo: "o/r", number: 7, add: ["ann"], remove: [], account: "work" }
    expect((await d.reviewers(req)).ok).toBe(false)
    refuse = false
    const res = await d.reviewers(req)
    expect(res).toMatchObject({ ok: true, row: { number: 7, account: "work" } })
    expect(run.mock.calls.filter(([, a]) => a[1] === "token")).toHaveLength(2) // asked again
  })
})

describe("several gh accounts, round 3", () => {
  const two = JSON.stringify({
    hosts: {
      "github.com": [
        { login: "me", active: true, state: "success" },
        { login: "work", active: false, state: "success" },
      ],
    },
  })
  const one = JSON.stringify({
    hosts: { "github.com": [{ login: "me", active: true, state: "success" }] },
  })
  const lists = (visible: boolean) =>
    JSON.stringify({
      data: {
        mine: { nodes: [] },
        review: { nodes: [] },
        repo: { nodes: [] },
        visible: visible ? { id: "R" } : null,
      },
    })
  const tokenAsks = (run: { mock: { calls: Parameters<PrRunner>[] } }) =>
    run.mock.calls.filter(([, a]) => a[1] === "token").length

  it("a 401 on the lists drops that token: read again next time", async () => {
    let refuse = true
    const run = vi.fn<PrRunner>(async (_cmd, args, _c, _w, token) => {
      if (args[1] === "status") return two
      if (args[1] === "token") return `tok-${args.at(-1)}\n`
      if (token === "tok-work" && refuse)
        throw Object.assign(new Error("x"), { code: 1, stderr: "HTTP 401: Bad credentials" })
      return lists(false)
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    await d.lists({ closed: false, account: "work" })
    refuse = false
    await d.lists({ closed: true, account: "work" })
    expect(tokenAsks(run)).toBe(2)
  })

  it("our own refusal doesn't drop the accounts' cache (gh never saw it)", async () => {
    const run = vi.fn<PrRunner>(async (_cmd, args) => (args[1] === "status" ? two : lists(true)))
    const d = new PrDashboard(run, Date.now, async () => true)
    await d.detail({ repo: "o/r", number: 1, account: "gone" })
    await d.detail({ repo: "o/r", number: 2, account: "gone" })
    expect(run.mock.calls.filter(([, a]) => a[1] === "status")).toHaveLength(1)
  })

  it("one account: its rows are tagged and run as it", async () => {
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args[1] === "status") return one
      if (args[1] === "token") return "tok-me\n"
      return JSON.stringify({
        data: { mine: { nodes: [{ number: 1, url: "u1", state: "OPEN" }] }, review: { nodes: [] } },
      })
    })
    const res = await new PrDashboard(run, Date.now, async () => true).lists({ closed: false })
    expect(res).toMatchObject({ ok: true, lists: { mine: [{ number: 1, account: "me" }] } })
    expect(queries(run)[0]![4]).toBe("tok-me")
  })

  it("a picked account while gh can't say which are logged in: refused, not run as gh's", async () => {
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args[0] === "auth") throw new Error("gh broke")
      return lists(true)
    })
    const res = await new PrDashboard(run, Date.now, async () => true).lists({
      closed: false,
      account: "work",
    })
    expect(res).toMatchObject({ ok: false })
    expect(queries(run)).toHaveLength(0)
  })

  it("the repo fallback asks only for the repo, and not of an account that just failed", async () => {
    const three = JSON.stringify({
      hosts: {
        "github.com": [
          { login: "me", active: true, state: "success" },
          { login: "down", active: false, state: "success" },
          { login: "work", active: false, state: "success" },
        ],
      },
    })
    const run = vi.fn<PrRunner>(async (cmd, args, _c, _w, token) => {
      if (cmd === "git") return "origin\tgit@github.com:o/r.git (fetch)\n"
      if (args[1] === "status") return three
      if (args[1] === "token") return `tok-${args.at(-1)}\n`
      if (token === "tok-down") throw Object.assign(new Error("x"), { code: 1, stderr: "boom" })
      return lists(token === "tok-work")
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.lists({ cwd: "/w/r", closed: false })
    expect(res).toMatchObject({ ok: true, lists: { repoAccount: "work" } })
    const repoOnly = queries(run).filter(([, a]) => a.includes("withLists=false"))
    expect(repoOnly.map(([, , , , t]) => t)).toEqual(["tok-work"])
  })
})

describe("PrDashboard.write", () => {
  // the PR's latest comments and reviews: nothing of this account's yet
  const recent = (viewer = "me", comments: unknown[] = [], reviews: unknown[] = []) =>
    JSON.stringify({
      data: {
        viewer: { login: viewer },
        repository: { pullRequest: { comments: { nodes: comments }, reviews: { nodes: reviews } } },
      },
    })
  const isRecent = (args: string[]) => args.some((a) => a.includes("viewer { login }"))
  const rowAnswer = JSON.stringify({
    data: {
      repository: {
        pullRequest: { number: 7, url: "u", state: "OPEN", reviewDecision: "APPROVED" },
      },
    },
  })

  it("the text goes to gh on stdin; the PR's row is fetched again", async () => {
    const run = vi.fn<PrRunner>(async (_cmd, args) =>
      args[0] === "pr" ? "" : isRecent(args) ? recent() : rowAnswer,
    )
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.write({
      repo: "o/r",
      number: 7,
      action: "comment",
      body: " hi\nthere ",
      cwd: "/w",
    })
    expect(res).toMatchObject({ ok: true, row: { number: 7, review: "approved" } })
    const [cmd, args, cwd, , token, input] = run.mock.calls.find(([, a]) => a[0] === "pr")!
    expect([cmd, args.slice(0, 2), cwd, token, input]).toEqual([
      "gh",
      ["pr", "comment"],
      "/w",
      undefined,
      " hi\nthere", // (only the end trimmed: a leading indent is Markdown)
    ])
    expect(args.join(" ")).not.toContain("there")
  })

  it("as the PR's account, or refused; gh's refusal is the answer", async () => {
    const status = JSON.stringify({
      hosts: {
        "github.com": [
          { login: "me", active: true, state: "success" },
          { login: "work", state: "success" },
        ],
      },
    })
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args[1] === "status") return status
      if (args[1] === "token") return `tok-${args.at(-1)}\n`
      if (args[0] === "pr")
        throw Object.assign(new Error("x"), {
          code: 1,
          stderr: "Can not approve your own pull request",
        })
      return isRecent(args) ? recent("work") : rowAnswer
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.write({
      repo: "o/r",
      number: 7,
      action: "approve",
      body: "",
      account: "work",
    })
    expect(res).toEqual({
      ok: false,
      error: "failed",
      message: "Can not approve your own pull request",
    })
    expect(run.mock.calls.find(([, a]) => a[0] === "pr")![4]).toBe("tok-work")
    const before = run.mock.calls.length
    expect(
      await d.write({ repo: "o/r", number: 7, action: "comment", body: "x", account: "gone" }),
    ).toMatchObject({
      ok: false,
      error: "unauthenticated",
    })
    expect(run.mock.calls.slice(before).some(([, a]) => a[0] === "pr")).toBe(false)
    expect(await d.write({ repo: "o/r", number: 7, action: "comment", body: " " })).toMatchObject({
      ok: false,
    })
  })
})

describe("PrDashboard.write, failures", () => {
  it("killed waiting: may have gone through, never 'offline'; too long: says so", async () => {
    const run = vi.fn<PrRunner>(async () => {
      throw Object.assign(new Error("x"), { killed: true, signal: "SIGTERM" })
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    const res = await d.write({ repo: "o/r", number: 7, action: "approve", body: "" })
    expect(res).toMatchObject({
      ok: false,
      error: "failed",
      message: expect.stringContaining("may have gone through"),
    })
    const long = await d.write({
      repo: "o/r",
      number: 7,
      action: "comment",
      body: "x".repeat(70_000),
    })
    expect(long).toMatchObject({ ok: false, message: expect.stringContaining("Too long") })
  })
})

describe("PrDashboard.write, timeouts", () => {
  it("gh's own request timing out: may have gone through; a slow gh auth: nothing sent", async () => {
    const run = vi.fn<PrRunner>(async () => {
      throw Object.assign(new Error("x"), {
        code: 1,
        stderr: 'Post "https://api.github.com/graphql": context deadline exceeded',
      })
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.write({ repo: "o/r", number: 7, action: "comment", body: "hi" })).toMatchObject({
      message: expect.stringContaining("may have gone through"),
    })
    const status = JSON.stringify({
      hosts: {
        "github.com": [
          { login: "me", active: true, state: "success" },
          { login: "work", state: "success" },
        ],
      },
    })
    const slowAuth = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args[1] === "status") return status
      throw Object.assign(new Error("x"), { killed: true }) // gh auth token hangs, killed
    })
    const d2 = new PrDashboard(slowAuth, Date.now, async () => true)
    const res = await d2.write({
      repo: "o/r",
      number: 7,
      action: "comment",
      body: "hi",
      account: "work",
    })
    expect(res).toMatchObject({ ok: false })
    expect(JSON.stringify(res)).not.toContain("may have gone through")
    expect(slowAuth.mock.calls.some(([, a]) => a[0] === "pr")).toBe(false)
  })
})

describe("PrDashboard.write never posts twice", () => {
  const recent = (comments: unknown[] = []) =>
    JSON.stringify({
      data: {
        viewer: { login: "me" },
        repository: { pullRequest: { comments: { nodes: comments }, reviews: { nodes: [] } } },
      },
    })
  const mineNow = () => [
    { author: { login: "me" }, body: "LGTM", createdAt: new Date().toISOString() },
  ]
  const isRecent = (args: string[]) => args.some((a) => a.includes("viewer { login }"))
  const req = { repo: "o/r", number: 7, action: "comment" as const, body: "LGTM" }
  const fail = (stderr: string) => Object.assign(new Error("x"), { code: 1, stderr })

  it("a repeat on purpose (a /retest) goes out: no check without an unclear try", async () => {
    const run = vi.fn<PrRunner>(async (_cmd, args) => (isRecent(args) ? recent(mineNow()) : "{}"))
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.write(req)).toMatchObject({ ok: true })
    expect(await d.write(req)).toMatchObject({ ok: true })
    expect(run.mock.calls.filter(([, a]) => a[0] === "pr")).toHaveLength(2)
    expect(run.mock.calls.some(([, a]) => isRecent(a))).toBe(false)
  })

  it("a 502 that landed: went through; one that didn't (yet): may have, and a retry asks first", async () => {
    let posted = false
    let lands = true
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (isRecent(args)) return recent(posted ? mineNow() : [])
      if (args[0] === "pr") {
        posted = lands
        throw fail("HTTP 502: Bad Gateway")
      }
      return "{}"
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.write(req)).toMatchObject({ ok: true })
    lands = false
    posted = false
    expect(await d.write(req)).toMatchObject({
      ok: false,
      message: expect.stringContaining("may have gone through"),
    })
    // GitHub shows it a moment later: the retry finds it there, sends nothing
    posted = true
    const prs = run.mock.calls.filter(([, a]) => a[0] === "pr").length
    expect(await d.write(req)).toMatchObject({ ok: true, already: true })
    expect(run.mock.calls.filter(([, a]) => a[0] === "pr")).toHaveLength(prs)
  })

  it("a clear refusal: a plain failure, no check; can't ask GitHub after an unclear one: may have", async () => {
    const refused = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args[0] === "pr") throw fail("GraphQL: Pull request review thread is locked")
      return "{}"
    })
    expect(await new PrDashboard(refused, Date.now, async () => true).write(req)).toEqual({
      ok: false,
      error: "failed",
      message: "GraphQL: Pull request review thread is locked",
    })
    expect(refused.mock.calls.some(([, a]) => isRecent(a))).toBe(false)
    const blind = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args[0] === "pr") throw fail("unexpected EOF")
      throw new Error("offline")
    })
    expect(await new PrDashboard(blind, Date.now, async () => true).write(req)).toMatchObject({
      message: expect.stringContaining("may have gone through"),
    })
  })

  it("the same write asked twice while it runs (a reload mid-send): one run, one answer", async () => {
    let release: () => void = () => {}
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (args[0] === "pr") await new Promise<void>((r) => (release = r))
      return "{}"
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    const a = d.write(req)
    const b = d.write(req)
    await vi.waitFor(() => expect(run.mock.calls.some(([, x]) => x[0] === "pr")).toBe(true))
    release()
    expect(await a).toBe(await b)
    expect(run.mock.calls.filter(([, x]) => x[0] === "pr")).toHaveLength(1)
  })
})

describe("PrDashboard.write unclear tries", () => {
  const isRecent = (args: string[]) => args.some((a) => a.includes("viewer { login }"))
  const none = JSON.stringify({
    data: {
      viewer: { login: "me" },
      repository: { pullRequest: { comments: { nodes: [] }, reviews: { nodes: [] } } },
    },
  })
  const req = { repo: "o/r", number: 7, action: "comment" as const, body: "/retest" }
  const fail = (stderr: string) => Object.assign(new Error("x"), { code: 1, stderr })

  it("offline (never connected): a plain failure, a retry goes out", () => {
    expect(unclearFailure(fail("dial tcp 140.82.1.1:443: i/o timeout"))).toBe(false)
    expect(unclearFailure(fail("HTTP 502: Bad Gateway"))).toBe(true)
    expect(unclearFailure(fail("net/http: request canceled"))).toBe(true)
    expect(unclearFailure(Object.assign(new Error("x"), { killed: true }))).toBe(true)
  })

  it("a refusal on a retry keeps the earlier try remembered; can't check: not sent", async () => {
    let step = "unclear"
    let canAsk = true
    const run = vi.fn<PrRunner>(async (_cmd, args) => {
      if (isRecent(args)) {
        if (!canAsk) throw new Error("offline")
        return none
      }
      if (args[0] === "pr") {
        if (step === "unclear") throw fail("HTTP 504: Gateway Timeout")
        if (step === "refused") throw fail("GraphQL: was submitted too quickly")
      }
      return "{}"
    })
    const d = new PrDashboard(run, Date.now, async () => true)
    expect(await d.write(req)).toMatchObject({
      message: expect.stringContaining("may have gone through"),
    })
    step = "refused"
    expect(await d.write(req)).toMatchObject({
      ok: false,
      message: "GraphQL: was submitted too quickly",
    })
    step = "ok"
    canAsk = false
    const prs = run.mock.calls.filter(([, a]) => a[0] === "pr").length
    expect(await d.write(req)).toMatchObject({
      ok: false,
      message: expect.stringContaining("wasn't sent"),
    })
    expect(run.mock.calls.filter(([, a]) => a[0] === "pr")).toHaveLength(prs) // still checked first
  })
})
