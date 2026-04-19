import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymap, stringifyKeySequence } from "../index.js"
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
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerEmacsBindings(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "save-buffer",
          run() {
            calls.push("save")
          },
        },
      ],
    })

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("ctrl+x")

    mockInput.pressKey("s", { ctrl: true })
    expect(calls).toEqual(["save"])
  })

  test("keeps emacs syntax unavailable until the addon is registered", () => {
    const keymap = getKeymap(renderer)
    const errors: string[] = []

    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    expect(() => {
      keymap.registerLayer({
        scope: "global",
        bindings: [{ key: "ctrl+x ctrl+s", cmd() {} }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
    expect(keymap.getActiveKeys()).toEqual([])
  })

  test("can be disposed to restore default parsing behavior", () => {
    const keymap = getKeymap(renderer)
    const errors: string[] = []

    const offEmacsBindings = registerEmacsBindings(keymap)
    offEmacsBindings()

    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    expect(() => {
      keymap.registerLayer({
        scope: "global",
        bindings: [{ key: "ctrl+x ctrl+s", cmd() {} }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
    expect(keymap.getActiveKeys()).toEqual([])
  })
})
