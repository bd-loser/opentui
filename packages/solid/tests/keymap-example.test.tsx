import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { testRender } from "../index.js"
import KeymapDemo from "../examples/components/keymap-demo.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

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

  test("renders and responds to global and local keymaps", async () => {
    testSetup = await testRender(() => <KeymapDemo />, { width: 60, height: 20 })
    await testSetup.renderOnce()

    testSetup.mockInput.pressKey("j")
    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("Count: 1")

    testSetup.mockInput.pressTab()
    await testSetup.renderOnce()
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
