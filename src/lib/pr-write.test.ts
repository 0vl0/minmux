import { describe, expect, it } from "vitest"
import { parsePrRow } from "./pr-dashboard"
import { BODY_MAX, writeActions, writeArgs } from "./pr-write"

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
