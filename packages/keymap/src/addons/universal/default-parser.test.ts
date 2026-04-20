import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { KeyEvent, Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { Keymap } from "@opentui/keymap"
import { registerDefaultKeys } from "@opentui/keymap/addons"
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui"

let renderer: TestRenderer
let mockInput: MockInput

describe("default parser addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 12 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("bare keymaps do not parse string bindings until the addon is registered", () => {
    const keymap = new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer))
    const errors: string[] = []

    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    keymap.registerLayer({
      scope: "global",
      commands: [{ name: "run", run() {} }],
      bindings: [{ key: "x", cmd: "run" }],
    })

    expect(errors).toEqual(["No keymap binding parsers are registered"])
    expect(keymap.getActiveKeys()).toEqual([])
  })

  test("registerDefaultKeys restores the standard parser and event matching", () => {
    const keymap = new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer))
    const calls: string[] = []

    registerDefaultKeys(keymap)

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "run",
          run() {
            calls.push("run")
          },
        },
      ],
      bindings: [{ key: "<leader>d", cmd: "run" }],
    })
    keymap.registerToken({ name: "<leader>", key: { name: "x", ctrl: true } })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("d")

    expect(calls).toEqual(["run"])
  })

  test('registerDefaultKeys keeps the " " to "space" mapping in the addon, not the engine', () => {
    const keymap = new Keymap<Renderable, KeyEvent>(createOpenTuiKeymapHost(renderer))
    const calls: string[] = []

    registerDefaultKeys(keymap)

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "space",
          run() {
            calls.push("space")
          },
        },
      ],
      bindings: [{ key: " ", cmd: "space" }],
    })

    mockInput.pressKey(" ")

    expect(calls).toEqual(["space"])
  })
})
