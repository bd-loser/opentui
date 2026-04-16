import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager, stringifyKeySequence } from "../index.js"
import { registerEmacsBindings } from "./emacs-bindings.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("emacs bindings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("supports emacs-style multi-stroke definitions when the addon is registered", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    registerEmacsBindings(manager)
    manager.registerCommands([
      {
        name: "save-buffer",
        run() {
          calls.push("save")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    expect(stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true })).toBe("ctrl+x")

    mockInput.pressKey("s", { ctrl: true })
    expect(calls).toEqual(["save"])
  })

  test("keeps emacs syntax unavailable until the addon is registered", () => {
    const manager = getKeymapManager(renderer)
    const errors: string[] = []

    manager.on("error", (event) => {
      errors.push(event.message)
    })

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "ctrl+x ctrl+s", cmd() {} }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
    expect(manager.getActiveKeys()).toEqual([])
  })

  test("can be disposed to restore default parsing behavior", () => {
    const manager = getKeymapManager(renderer)
    const errors: string[] = []

    const offEmacsBindings = registerEmacsBindings(manager)
    offEmacsBindings()

    manager.on("error", (event) => {
      errors.push(event.message)
    })

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "ctrl+x ctrl+s", cmd() {} }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
    expect(manager.getActiveKeys()).toEqual([])
  })
})
