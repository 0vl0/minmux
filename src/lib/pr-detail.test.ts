import { describe, expect, it } from "vitest"
import {
  bodyBlocks,
  hunkTail,
  linkify,
  parsePrDetail,
  threadsByFile,
  when,
  type PrThread,
} from "./pr-detail"

const answer = (pr: Record<string, unknown>) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          url: "https://github.com/o/r/pull/7",
          updatedAt: "2026-10-14T10:00:00Z",
          body: "Body",
          reviews: { totalCount: 0, nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          reviewThreads: { totalCount: 0, nodes: [] },
          ...pr,
        },
      },
    },
  })

describe("parsePrDetail", () => {
  it("the conversation: comments and reviews that say or decide something, oldest first", () => {
    const d = parsePrDetail(
      answer({
        comments: {
          totalCount: 1,
          nodes: [
            { author: { login: "a" }, body: "hi", createdAt: "2026-10-14T09:00:00Z", url: "c1" },
          ],
        },
        reviews: {
          totalCount: 3,
          nodes: [
            {
              author: { login: "b" },
              state: "APPROVED",
              body: "",
              submittedAt: "2026-10-14T08:00:00Z",
              url: "r1",
            },
            {
              author: { login: "c" },
              state: "COMMENTED",
              body: "",
              submittedAt: "2026-10-14T08:30:00Z",
              url: "r2",
            },
            {
              author: null,
              state: "CHANGES_REQUESTED",
              body: "fix",
              submittedAt: "2026-10-14T09:30:00Z",
              url: "r3",
            },
          ],
        },
      }),
    )!
    expect(d.conversation.map((e) => [e.kind, e.author, e.state])).toEqual([
      ["review", "b", "approved"],
      ["comment", "a", undefined],
      ["review", "ghost", "changes"], // a deleted account
    ])
    expect(d.more).toBe(false)
  })

  it("review threads: file, line, resolved / outdated, the first comment's hunk", () => {
    const d = parsePrDetail(
      answer({
        reviewThreads: {
          totalCount: 1,
          nodes: [
            {
              isResolved: false,
              isOutdated: true,
              path: "src/a.ts",
              line: null,
              comments: {
                totalCount: 2,
                nodes: [
                  {
                    author: { login: "a" },
                    body: "why?",
                    createdAt: "t1",
                    url: "u1",
                    diffHunk: "@@ -1 +1 @@\n-x\n+y",
                  },
                  {
                    author: { login: "me" },
                    body: "because",
                    createdAt: "t2",
                    url: "u2",
                    diffHunk: "",
                  },
                ],
              },
            },
            { path: "" }, // not a thread
          ],
        },
      }),
    )!
    expect(d.threads).toEqual([
      {
        path: "src/a.ts",
        line: null,
        resolved: false,
        outdated: true,
        hunk: "@@ -1 +1 @@\n-x\n+y",
        comments: [
          { author: "a", body: "why?", at: "t1", url: "u1" },
          { author: "me", body: "because", at: "t2", url: "u2" },
        ],
      },
    ])
  })

  it("more than the query asks for: says so", () => {
    expect(parsePrDetail(answer({ comments: { totalCount: 101, nodes: [] } }))!.more).toBe(true)
  })

  it("not an answer (no such PR, garbage): null", () => {
    expect(parsePrDetail("x")).toBeNull()
    expect(
      parsePrDetail(JSON.stringify({ data: { repository: { pullRequest: null } } })),
    ).toBeNull()
  })
})

describe("threadsByFile", () => {
  const t = (path: string, line: number | null, over: Partial<PrThread> = {}): PrThread => ({
    path,
    line,
    resolved: false,
    outdated: false,
    hunk: "",
    comments: [],
    ...over,
  })
  it("files in path order; open threads first, then by line", () => {
    const out = threadsByFile([
      t("b.ts", 1),
      t("a.ts", 9),
      t("a.ts", 3, { resolved: true }),
      t("a.ts", 5),
    ])
    expect(out.map((f) => [f.path, f.threads.map((x) => x.line), f.open])).toEqual([
      ["a.ts", [5, 9, 3], 2],
      ["b.ts", [1], 1],
    ])
  })
})

describe("hunkTail", () => {
  it("the last lines, without the @@ header", () => {
    expect(hunkTail("@@ -1,3 +1,3 @@\n a\n-b\n+c", 2)).toEqual(["-b", "+c"])
  })
})

describe("bodyBlocks", () => {
  it("text and fenced code, in order", () => {
    expect(bodyBlocks("Intro\n\n```ts\nconst x = 1\n```\nAfter")).toEqual([
      { code: false, text: "Intro" },
      { code: true, text: "const x = 1" },
      { code: false, text: "After" },
    ])
    expect(bodyBlocks("  ")).toEqual([])
    expect(bodyBlocks("<img src=x onerror=alert(1)>")).toEqual([
      { code: false, text: "<img src=x onerror=alert(1)>" }, // text, never HTML
    ])
  })
})

describe("linkify", () => {
  it("http(s) links, trailing punctuation left out", () => {
    expect(linkify("see https://x.io/a, ok")).toEqual([
      { text: "see " },
      { text: "https://x.io/a", url: "https://x.io/a" },
      { text: ", ok" },
    ])
    expect(linkify("javascript:alert(1)")).toEqual([{ text: "javascript:alert(1)" }])
  })
})

describe("when", () => {
  const now = Date.parse("2026-10-14T12:00:00Z")
  it("short and relative, then a date", () => {
    expect(when("2026-10-14T11:59:50Z", now)).toBe("just now")
    expect(when("2026-10-14T11:30:00Z", now)).toBe("30 min ago")
    expect(when("2026-10-13T12:00:00Z", now)).toBe("24 h ago")
    expect(when("2026-10-01T00:00:00Z", now)).toBe("2026-10-01")
    expect(when("", now)).toBe("")
  })
})
