import { describe, expect, it } from "vitest"
import { modeReport, namesThemeMode, reportsTo, schemeReport } from "./theme-notify"

describe("theme notify (DEC mode 2031)", () => {
  it("reports dark as 1 and light as 2", () => {
    expect(schemeReport("dark")).toBe("\x1b[?997;1n")
    expect(schemeReport("light")).toBe("\x1b[?997;2n")
  })

  it("answers DECRQM with set or reset", () => {
    expect(modeReport(true)).toBe("\x1b[?2031;1$y")
    expect(modeReport(false)).toBe("\x1b[?2031;2$y")
  })

  it("finds the mode among several DECSET params", () => {
    expect(namesThemeMode([1004, 2004, 2031])).toBe(true)
    expect(namesThemeMode([1000, [2031]])).toBe(false) // CSI ? 1000:2031 h: a sub-parameter
    expect(namesThemeMode([2031, [1]])).toBe(false) // CSI ? 2031:1 h: not the plain mode
    expect(namesThemeMode([2031, 1004])).toBe(true)
    expect(namesThemeMode([1049, 2004])).toBe(false)
  })
})

describe("reportsTo: who hears of a palette change", () => {
  const all = { optedIn: true, commandRunning: true, agentLive: true }
  it("a live agent that asked, while it runs", () => {
    expect(reportsTo(all)).toBe(true)
  })
  it("never a shell (nothing running), a program that didn't ask, or one no agent runs in", () => {
    expect(reportsTo({ ...all, commandRunning: false })).toBe(false)
    expect(reportsTo({ ...all, optedIn: false })).toBe(false)
    expect(reportsTo({ ...all, agentLive: false })).toBe(false) // a crashed agent's `read x`
  })
})
