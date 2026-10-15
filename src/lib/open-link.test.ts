import { beforeEach, describe, expect, it, vi } from "vitest"
import { openLink } from "./open-link"
import { ipc } from "./ipc"
import { useStore } from "../store"
import { resetStore } from "../test/helpers"

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("openLink", () => {
  it("a GitHub PR opens the dialog on it; anything else, the browser", () => {
    openLink("https://github.com/o/r/pull/9/files")
    expect(useStore.getState()).toMatchObject({
      prDialogOpen: true,
      prLink: { repo: "o/r", number: 9 },
    })
    expect(ipc.openExternal).not.toHaveBeenCalled()
    openLink("https://example.com/x")
    expect(ipc.openExternal).toHaveBeenCalledWith("https://example.com/x")
  })

  it("gh not installed: a PR opens in the browser (the dialog couldn't show it)", () => {
    useStore.getState().setGhMissing(true)
    openLink("https://github.com/o/r/pull/9")
    expect(ipc.openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/9")
    expect(useStore.getState().prDialogOpen).toBe(false)
  })

  it("closing the dialog forgets the link", () => {
    openLink("https://github.com/o/r/pull/9")
    useStore.getState().setPrDialogOpen(false)
    expect(useStore.getState().prLink).toBeNull()
  })
})
