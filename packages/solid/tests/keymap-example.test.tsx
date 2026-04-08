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

    let frame = testSetup.captureCharFrame()
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
