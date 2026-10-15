import { describe, expect, it } from "vitest"
import { findErrorText, prRefOfUrl } from "./pr-link"

describe("prRefOfUrl", () => {
  it("a PR link, with a tab, anchor or query after it", () => {
    for (const u of [
      "https://github.com/vcmf/minmux/pull/138",
      "https://github.com/vcmf/minmux/pull/138/files",
      "https://github.com/vcmf/minmux/pull/138#discussion_r1",
      "http://www.github.com/vcmf/minmux/pull/138?w=1",
    ])
      expect(prRefOfUrl(u)).toEqual({ repo: "vcmf/minmux", number: 138 })
    expect(prRefOfUrl("https://github.com/o/my.repo/pull/2")).toEqual({
      repo: "o/my.repo",
      number: 2,
    })
  })

  it("anything else: an issue, a PR list, another host, a longer number", () => {
    for (const u of [
      "https://github.com/vcmf/minmux/issues/138",
      "https://github.com/vcmf/minmux/pulls",
      "https://github.com/vcmf/minmux/pull/0",
      "https://github.com/vcmf/minmux/pull/138x",
      "https://gitlab.com/vcmf/minmux/pull/138",
      "https://github.com.evil.io/vcmf/minmux/pull/138",
      "https://github.com/-x/minmux/pull/1",
    ])
      expect(prRefOfUrl(u)).toBeNull()
  })
})

describe("findErrorText", () => {
  it("names the accounts tried and how to log in; other failures as the dialog says them", () => {
    const pr = { repo: "x/y", number: 3 }
    expect(
      findErrorText({ ok: false, error: "failed", notFound: true, tried: ["me"] }, pr),
    ).toMatch(/^gh's account @me can't see x\/y#3\. .*gh auth login/)
    expect(findErrorText({ ok: false, error: "offline" }, pr)).toBe("Can't reach GitHub.")
  })
})
