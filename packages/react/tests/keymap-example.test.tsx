import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "../src/test-utils.js"
import KeymapDemo from "../examples/keymap.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

function getRenderable(id: string) {
  return testSetup.renderer.root.findDescendantById(id)!
}

describe("react keymap example", () => {
  beforeEach(async () => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  afterEach(() => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  test("stacks the demo sections without spacer rows", async () => {
    await act(async () => {
      testSetup = await testRender(<KeymapDemo />, { width: 70, height: 24 })
      await testSetup.renderOnce()
    })

    const title = getRenderable("keymap-demo-title")
    const subtitle = getRenderable("keymap-demo-subtitle")
    const panels = getRenderable("keymap-demo-panels")
    const editors = getRenderable("keymap-demo-editors")
    const footer = getRenderable("keymap-demo-footer")

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-alpha")
    expect(subtitle.y).toBe(title.y + title.height)
    expect(panels.y).toBe(subtitle.y + subtitle.height)
    expect(editors.y).toBe(panels.y + panels.height)
    expect(footer.y).toBe(editors.y + editors.height)
  })
})
