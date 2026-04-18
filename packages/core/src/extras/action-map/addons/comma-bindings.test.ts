import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getActionMap } from "../index.js"
import { registerCommaBindings } from "./comma-bindings.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("comma bindings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("splits comma-delimited key strings into multiple bindings", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    registerCommaBindings(actionMap)
    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "command",
        run() {
          calls.push("command")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x, y", cmd: "command" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["command", "command"])
  })

  test("skips bindings when a comma-delimited key string contains empty entries", () => {
    const actionMap = getActionMap(renderer)
    const errors: string[] = []

    actionMap.on("error", (event) => {
      errors.push(event.message)
    })
    registerCommaBindings(actionMap)

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "x,,y", cmd() {} }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key sequence "x,,y": comma-separated bindings cannot contain empty entries'])
    expect(actionMap.getActiveKeys()).toEqual([])
  })

  test("can be disposed to restore default comma behavior", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const offCommaBindings = registerCommaBindings(actionMap)
    offCommaBindings()

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "sequence",
        run() {
          calls.push("sequence")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x,y", cmd: "sequence" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    mockInput.pressKey(",")
    mockInput.pressKey("y")

    expect(calls).toEqual(["sequence"])
  })
})
