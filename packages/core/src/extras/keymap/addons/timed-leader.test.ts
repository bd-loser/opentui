import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { registerTimedLeader } from "./timed-leader.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("timed leader addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("supports leader extensions", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "leader-action",
        run() {
          calls.push("leader")
        },
      },
    ])

    registerTimedLeader(manager, {
      trigger: { name: "x", ctrl: true },
    })

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("disarms after its timeout", async () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "leader-action",
        run() {
          calls.push("leader")
        },
      },
    ])

    registerTimedLeader(manager, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 5,
    })

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    await Bun.sleep(20)
    mockInput.pressKey("a")

    expect(calls).toEqual([])
  })
})
