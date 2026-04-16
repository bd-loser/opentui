import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { InputRenderable } from "@opentui/core"
import { act } from "react"
import { testRender } from "../src/test-utils.js"
import ActionMapDemo from "../examples/action-map.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

function getRenderable(id: string) {
  return testSetup.renderer.root.findDescendantById(id)!
}

function getInput(id: string): InputRenderable {
  return testSetup.renderer.root.findDescendantById(id) as InputRenderable
}

describe("react action map example", () => {
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
      testSetup = await testRender(<ActionMapDemo />, { width: 70, height: 24 })
    })
    await testSetup.renderOnce()

    const title = getRenderable("action-map-demo-title")
    const subtitle = getRenderable("action-map-demo-subtitle")
    const panels = getRenderable("action-map-demo-panels")
    const editors = getRenderable("action-map-demo-editors")
    const footer = getRenderable("action-map-demo-footer")

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("action-map-demo-alpha")
    expect(subtitle.y).toBe(title.y + title.height)
    expect(panels.y).toBe(subtitle.y + subtitle.height)
    expect(editors.y).toBe(panels.y + panels.height)
    expect(footer.y).toBe(editors.y + editors.height)
  })

  test("opens the ex prompt, autocompletes :reset, and runs it", async () => {
    await act(async () => {
      testSetup = await testRender(<ActionMapDemo />, { width: 70, height: 24 })
    })
    await testSetup.renderOnce()
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey(":")
    })
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("action-map-demo-ex-input")
    expect(testSetup.captureCharFrame()).toContain("Ex Command")

    const prompt = getRenderable("action-map-demo-ex-prompt")
    const promptList = getRenderable("action-map-demo-ex-prompt-list")
    const promptY = prompt.y
    expect(promptList.y).toBe(prompt.y + prompt.height)

    act(() => {
      testSetup.mockInput.pressKey("r")
    })
    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain(":reset")
    expect(getRenderable("action-map-demo-ex-prompt").y).toBe(promptY)
    expect(getRenderable("action-map-demo-ex-prompt-list").y).toBe(prompt.y + prompt.height)

    act(() => {
      testSetup.mockInput.pressTab()
    })
    await testSetup.renderOnce()
    expect(getInput("action-map-demo-ex-input").value).toBe(":reset")

    act(() => {
      testSetup.mockInput.pressEnter()
    })
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("action-map-demo-alpha")
    expect(testSetup.captureCharFrame()).toContain("Counters reset through :")
    expect(testSetup.captureCharFrame()).toContain("Count: 0")
  })
})
