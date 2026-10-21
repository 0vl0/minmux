import { describe, expect, it } from "vitest"
import { labelColors, labelUrl, parseLabels } from "./pr-labels"

describe("parseLabels", () => {
  it("names, colours and descriptions; how many in all", () => {
    expect(
      parseLabels({
        totalCount: 4,
        nodes: [
          { name: "bug", color: "D73A4A", description: "Something isn't working" },
          { name: "odd", color: "nothex" },
          { name: "" },
        ],
      }),
    ).toEqual({
      labels: [
        { name: "bug", color: "d73a4a", description: "Something isn't working" },
        { name: "odd", color: "", description: "" },
      ],
      total: 4,
    })
    expect(parseLabels(undefined)).toEqual({ labels: [], total: 0 })
  })
})

describe("labelColors", () => {
  it("a tint of the colour, its text light on a dark theme and dark on a light one", () => {
    const dark = labelColors("0e8a16", "dark")!
    expect(dark.background).toBe("rgba(14, 138, 22, 0.18)")
    expect(dark.borderColor).toMatch(/^hsla\(\d+, \d+%, 70%, 0.45\)$/)
    expect(dark.color).toMatch(/^hsl\(\d+, \d+%, 70%\)$/) // (lightened: it was ~30%)
    const light = labelColors("fbca04", "light")!
    expect(light.color).toMatch(/32%\)$/) // (a yellow: darkened to be read on white)
    expect(labelColors("ededed", "dark")!.color).toBe("hsl(0, 0%, 93%)") // (light enough)
    expect(labelColors("", "dark")).toBeNull()
  })
})

describe("labelUrl", () => {
  it("the repo's PRs with that label", () => {
    expect(labelUrl("o/r", "good first issue")).toBe(
      "https://github.com/o/r/pulls?q=is%3Apr%20label%3A%22good%20first%20issue%22",
    )
  })
})
