import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { TextareaRenderable } from "../index.js"
import { createTestRenderer } from "../testing.js"
import { destroy, run } from "./keymap-demo.js"

let testSetup: Awaited<ReturnType<typeof createTestRenderer>>

function getEditor(id: string): TextareaRenderable {
  return testSetup.renderer.root.findDescendantById(id) as TextareaRenderable
}

describe("keymap demo example", () => {
  beforeEach(async () => {
    testSetup = await createTestRenderer({ width: 70, height: 24 })
  })

  afterEach(() => {
    if (testSetup) {
      destroy(testSetup.renderer)
      testSetup.renderer.destroy()
    }
  })

  test("renders the original panel demo and extends it with three textareas", async () => {
    run(testSetup.renderer)
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
})
