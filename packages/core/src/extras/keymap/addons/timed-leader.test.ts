import { Buffer } from "node:buffer"
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

  test("supports hyper leader triggers", () => {
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
      trigger: { name: "x", hyper: true },
    })

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[27;17;120~"))
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("disarms after its timeout", async () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    const states: string[] = []

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
      onArm() {
        states.push("armed")
      },
      onDisarm() {
        states.push("disarmed")
      },
    })

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    await Bun.sleep(20)
    mockInput.pressKey("a")

    expect(calls).toEqual([])
    expect(states).toEqual(["armed", "disarmed"])
  })

  test("disarms when disposed while armed", async () => {
    const manager = getKeymapManager(renderer)
    const states: string[] = []

    const off = registerTimedLeader(manager, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 5,
      onArm() {
        states.push("armed")
      },
      onDisarm() {
        states.push("disarmed")
      },
    })

    manager.registerCommands([
      {
        name: "leader-action",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    off()
    await Bun.sleep(20)

    expect(states).toEqual(["armed", "disarmed"])
  })
})
