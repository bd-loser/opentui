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

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-alpha")

    testSetup.mockInput.pressKey("j")
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Count: 1")

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("keymap-demo-beta")

    testSetup.mockInput.pressKey("j")
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Count: 5")

    testSetup.mockInput.pressKey("x", { ctrl: true })
    testSetup.mockInput.pressKey("s")
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Ex command: Saved via leader")

    testSetup.mockInput.pressKey("r", { ctrl: true })
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Count: 0")
    expect(frame).toContain("Counters reset through :reset")
  })
})
