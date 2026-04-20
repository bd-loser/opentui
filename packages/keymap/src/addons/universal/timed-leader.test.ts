import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { getKeymap } from "../../opentui.js"
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
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "leader-action",
          run() {
            calls.push("leader")
          },
        },
      ],
    })

    registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("supports hyper leader triggers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "leader-action",
          run() {
            calls.push("leader")
          },
        },
      ],
    })

    registerTimedLeader(keymap, {
      trigger: { name: "x", hyper: true },
    })

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[27;17;120~"))
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("disarms after its timeout", async () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const states: string[] = []

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "leader-action",
          run() {
            calls.push("leader")
          },
        },
      ],
    })

    registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 5,
      onArm() {
        states.push("armed")
      },
      onDisarm() {
        states.push("disarmed")
      },
    })

    keymap.registerLayer({
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
    const keymap = getKeymap(renderer)
    const states: string[] = []

    const off = registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 5,
      onArm() {
        states.push("armed")
      },
      onDisarm() {
        states.push("disarmed")
      },
    })

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "leader-action",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    off()
    await Bun.sleep(20)

    expect(states).toEqual(["armed", "disarmed"])
  })
})
