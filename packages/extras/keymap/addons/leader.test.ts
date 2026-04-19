import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { getKeymap } from "../opentui.js"
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
        {
          name: "plain-action",
          run() {
            calls.push("plain")
          },
        },
      ],
    })

    registerLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
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

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])

    registerLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader", "leader"])
  })

  test("can be disposed to remove the leader token mapping", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "leader-only",
          run() {
            calls.push("leader")
          },
        },
      ],
    })

    const offLeader = registerLeader(keymap, {
      trigger: { name: "x", ctrl: true },
    })

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>", cmd: "leader-only" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    expect(calls).toEqual(["leader"])

    offLeader()

    mockInput.pressKey("x", { ctrl: true })
    expect(calls).toEqual(["leader"])
  })
})
