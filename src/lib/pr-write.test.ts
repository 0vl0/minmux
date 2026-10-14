import { describe, expect, it } from "vitest"
import { parsePrRow } from "./pr-dashboard"
import { alreadyPosted, BODY_MAX, writeActions, writeArgs } from "./pr-write"

const req = (action: "comment" | "approve" | "changes", body: string) => ({
  repo: "o/r",
  number: 7,
  action,
  body,
})

describe("writeArgs", () => {
  it("the text always on stdin, never an argument", () => {
    expect(writeArgs(req("comment", "hi\nthere"))).toEqual([
      "pr",
      "comment",
      "7",
      "--repo",
      "o/r",
      "--body-file",
      "-",
    ])
    expect(writeArgs(req("changes", "fix it"))).toEqual([
      "pr",
      "review",
      "7",
      "--repo",
      "o/r",
      "--request-changes",
      "--body-file",
      "-",
    ])
    expect(writeArgs(req("approve", ""))).toEqual([
      "pr",
      "review",
      "7",
      "--repo",
      "o/r",
      "--approve",
    ])
    expect(writeArgs(req("approve", "lgtm"))).toContain("--body-file")
  })

  it("nothing to send: no run (a comment or a change request needs text; too long)", () => {
    expect(writeArgs(req("comment", "  \n"))).toBeNull()
    expect(writeArgs(req("changes", ""))).toBeNull()
    expect(writeArgs(req("comment", "x".repeat(BODY_MAX + 1)))).toBeNull()
    expect(writeArgs({ ...req("comment", "x"), number: 0 })).toBeNull()
  })
})

describe("writeActions", () => {
  const row = (state: string, author = "ann") =>
    parsePrRow({ number: 7, url: "u", state, author: { login: author } })!

  it("reviews on others' open PRs; a comment always", () => {
    expect(writeActions(row("OPEN"), "me")).toEqual(["comment", "approve", "changes"])
    expect(writeActions(row("OPEN", "Me"), "me")).toEqual(["comment"]) // your own: no review
    expect(writeActions(row("MERGED"), "me")).toEqual(["comment"])
    expect(writeActions(row("CLOSED"), "me")).toEqual(["comment"])
    expect(writeActions(row("OPEN"), undefined)).toEqual(["comment", "approve", "changes"])
  })
})

describe("alreadyPosted", () => {
  const T = Date.parse("2026-10-14T10:00:00Z")
  const out = (comments: unknown[], reviews: unknown[] = [], viewer = "me") =>
    JSON.stringify({
      data: {
        viewer: { login: viewer },
        repository: { pullRequest: { comments: { nodes: comments }, reviews: { nodes: reviews } } },
      },
    })
  const c = (login: string, body: string, at: string) => ({
    author: { login },
    body,
    createdAt: at,
  })
  const r = (login: string, state: string, body: string, at: string) => ({
    author: { login },
    state,
    body,
    submittedAt: at,
  })
  const req = (action: "comment" | "approve" | "changes", body: string) => ({
    repo: "o/r",
    number: 7,
    action,
    body,
  })

  it("the same text by the same account since then: there (line endings, trailing space aside)", () => {
    const o = out([c("Me", "LGTM\r\nnice", "2026-10-14T10:01:00Z")])
    expect(alreadyPosted(o, req("comment", "LGTM\nnice  "), T)).toBe(true)
    expect(alreadyPosted(o, req("comment", "LGTM"), T)).toBe(false)
    expect(alreadyPosted(o, req("comment", "LGTM\nnice"), T + 120_000)).toBe(false) // before
    expect(
      alreadyPosted(
        out([c("ann", "LGTM\nnice", "2026-10-14T10:01:00Z")]),
        req("comment", "LGTM\nnice"),
        T,
      ),
    ).toBe(false)
  })

  it("a review: its verdict (and its text, if any) by the same account", () => {
    const o = out([], [r("me", "APPROVED", "", "2026-10-14T10:01:00Z")])
    expect(alreadyPosted(o, req("approve", ""), T)).toBe(true)
    expect(alreadyPosted(o, req("approve", "with words"), T)).toBe(false)
    expect(alreadyPosted(o, req("changes", "fix"), T)).toBe(false)
  })

  it("not an answer: can't say", () => {
    expect(alreadyPosted("nope", req("comment", "x"), T)).toBeNull()
    expect(
      alreadyPosted(JSON.stringify({ data: { viewer: null } }), req("comment", "x"), T),
    ).toBeNull()
  })
})
