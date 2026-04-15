import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
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
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    registerCommaBindings(manager)
    manager.registerCommands([
      {
        name: "command",
        run() {
          calls.push("command")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x, y", cmd: "command" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["command", "command"])
  })

  test("throws when a comma-delimited key string contains empty entries", () => {
    const manager = getKeymapManager(renderer)

    registerCommaBindings(manager)

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x,,y", cmd() {} }],
      })
    }).toThrow('Invalid key sequence "x,,y": comma-separated bindings cannot contain empty entries')
  })

  test("can be disposed to restore default comma behavior", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const offCommaBindings = registerCommaBindings(manager)
    offCommaBindings()

    manager.registerCommands([
      {
        name: "sequence",
        run() {
          calls.push("sequence")
        },
      },
    ])

    manager.registerLayer({
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
