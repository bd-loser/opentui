import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer } from "../testing.js"
import { destroy, run } from "./keymap-demo.js"

let testSetup: Awaited<ReturnType<typeof createTestRenderer>>

describe("keymap demo example", () => {
  beforeEach(async () => {
    testSetup = await createTestRenderer({ width: 60, height: 20 })
  })

  afterEach(() => {
    if (testSetup) {
      destroy(testSetup.renderer)
      testSetup.renderer.destroy()
    }
  })

  test("renders and responds to local and global keymaps", async () => {
    run(testSetup.renderer)
    await testSetup.renderOnce()

    let frame = testSetup.captureCharFrame()
    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-alpha")
    expect(frame).toContain("Which Key")

    testSetup.mockInput.pressEnter()
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Ex command:")
    expect(frame).toContain("wrote")
    expect(frame).toContain("alpha-panel.txt")

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Prefix: <leader>")
    expect(frame).toContain("s -> :w session.log")

    testSetup.mockInput.pressKey("s")
    await testSetup.renderOnce()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("session.log")
    expect(frame).toContain("wrote")

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-beta")

    testSetup.mockInput.pressKey("j")
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Count: 5")

    testSetup.mockInput.pressKey("r", { ctrl: true })
    await testSetup.renderOnce()

    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Count: 0")
    expect(frame).toContain("reset through :reset")
  })
})
