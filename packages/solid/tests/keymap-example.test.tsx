import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { InputRenderable, TextareaRenderable } from "@opentui/core"
import { getKeymap } from "@opentui/extras/keymap/opentui"
import { testRender } from "../index.js"
import KeymapDemo from "../examples/components/keymap-demo.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

function getEditor(id: string): TextareaRenderable {
  return testSetup.renderer.root.findDescendantById(id) as TextareaRenderable
}

function getInput(id: string): InputRenderable {
  return testSetup.renderer.root.findDescendantById(id) as InputRenderable
}

function getRenderable(id: string) {
  return testSetup.renderer.root.findDescendantById(id)!
}

function getFrameWidths(): number[] {
  return ["notes", "draft", "scratch"].map((id) => {
    return testSetup.renderer.root.findDescendantById(`keymap-demo-editor-frame-${id}`)!.width
  })
}

describe("solid keymap example", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  test("renders the core-aligned keymap demo and supports textarea focus cycling", async () => {
    testSetup = await testRender(() => <KeymapDemo />, { width: 70, height: 24 })
    await testSetup.renderOnce()

    let frame = testSetup.captureCharFrame()
    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-alpha")
    expect(frame).toContain("Alpha")
    expect(frame).toContain("Beta")
    expect(frame).toContain("1. Notes")
    expect(frame).toContain("2. Draft")
    expect(frame).toContain("3. Scratch")
    expect(frame).toContain("Which Key")

    testSetup.mockInput.pressEnter()
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Wrote alpha-panel.txt")

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Which Key")
    expect(frame).toContain("<leader>")
    expect(frame).toContain("Write session log")

    testSetup.mockInput.pressKey("s")
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Wrote session.log")

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()
    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-beta")

    testSetup.mockInput.pressKey("j")
    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("Count: 5")

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()
    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-editor-1")
    expect(
      getKeymap(testSetup.renderer)
        .getActiveKeys({ includeMetadata: true })
        .find((candidate) => candidate.stroke.name === "d")?.bindingAttrs,
    ).toEqual({ group: "Delete" })

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()
    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-editor-2")

    const draftEditor = getEditor("keymap-demo-editor-2")
    testSetup.mockInput.pressKey("d")
    testSetup.mockInput.pressKey("d")
    await testSetup.renderOnce()
    expect(draftEditor.plainText).not.toContain("Draft editor")

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()
    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-editor-3")

    const scratchEditor = getEditor("keymap-demo-editor-3")
    testSetup.mockInput.pressKey("x")
    await testSetup.renderOnce()
    expect(scratchEditor.plainText).toBe("x")
  })

  test("keeps editor columns stable while typing in a wrapped textarea", async () => {
    testSetup = await testRender(() => <KeymapDemo />, { width: 70, height: 24 })
    await testSetup.renderOnce()

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()
    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-editor-1")

    const initialWidths = getFrameWidths()
    const initialLength = getEditor("keymap-demo-editor-1").plainText.length
    expect(Math.max(...initialWidths) - Math.min(...initialWidths)).toBeLessThanOrEqual(1)

    for (let i = 0; i < 24; i += 1) {
      testSetup.mockInput.pressKey("x")
      await testSetup.renderOnce()
    }

    expect(getEditor("keymap-demo-editor-1").plainText.length).toBe(initialLength + 24)
    expect(getFrameWidths()).toEqual(initialWidths)
  })

  test("stacks the demo sections without spacer rows", async () => {
    testSetup = await testRender(() => <KeymapDemo />, { width: 70, height: 24 })
    await testSetup.renderOnce()

    const title = getRenderable("keymap-demo-title")
    const subtitle = getRenderable("keymap-demo-subtitle")
    const panels = getRenderable("keymap-demo-panels")
    const editors = getRenderable("keymap-demo-editors")
    const footer = getRenderable("keymap-demo-footer")

    expect(subtitle.y).toBe(title.y + title.height)
    expect(panels.y).toBe(subtitle.y + subtitle.height)
    expect(editors.y).toBe(panels.y + panels.height)
    expect(footer.y).toBe(editors.y + editors.height)
  })

  test("opens the ex prompt, autocompletes :reset, and runs it", async () => {
    testSetup = await testRender(() => <KeymapDemo />, { width: 70, height: 24 })
    await testSetup.renderOnce()

    testSetup.mockInput.pressKey("j")
    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("Count: 1")

    testSetup.mockInput.pressKey(":")
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-ex-input")
    expect(testSetup.captureCharFrame()).toContain("Ex Command")

    const prompt = getRenderable("keymap-demo-ex-prompt")
    const promptList = getRenderable("keymap-demo-ex-prompt-list")
    const promptY = prompt.y
    expect(promptList.y).toBe(prompt.y + prompt.height)

    testSetup.mockInput.pressKey("r")
    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain(":reset")
    expect(getRenderable("keymap-demo-ex-prompt").y).toBe(promptY)
    expect(getRenderable("keymap-demo-ex-prompt-list").y).toBe(prompt.y + prompt.height)

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()
    expect(getInput("keymap-demo-ex-input").value).toBe(":reset")

    testSetup.mockInput.pressEnter()
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-alpha")
    expect(testSetup.captureCharFrame()).toContain("Counters reset through :")
    expect(testSetup.captureCharFrame()).toContain("Count: 0")
  })
})
