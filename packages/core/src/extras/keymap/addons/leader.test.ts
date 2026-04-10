import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { registerLeader } from "./leader.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("leader addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("registers leader as a plain token alias", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "leader-action",
        run() {
          calls.push("leader")
        },
      },
      {
        name: "plain-action",
        run() {
          calls.push("plain")
        },
      },
    ])

    registerLeader(manager, {
      trigger: { name: "x", ctrl: true },
    })

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "<leader>a", cmd: "leader-action" },
        { key: "a", cmd: "plain-action" },
      ],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])

    mockInput.pressKey("a")

    expect(calls).toEqual(["leader", "plain"])
  })

  test("recompiles bindings that were registered before leader exists", () => {
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

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])

    registerLeader(manager, {
      trigger: { name: "x", ctrl: true },
    })

    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader", "leader"])
  })
})
