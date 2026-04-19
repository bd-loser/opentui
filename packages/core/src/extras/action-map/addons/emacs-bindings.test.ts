import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getActionMap, stringifyKeySequence } from "../index.js"
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
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    registerEmacsBindings(actionMap)
    actionMap.registerLayer({
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

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    expect(stringifyKeySequence(actionMap.getPendingSequence(), { preferDisplay: true })).toBe("ctrl+x")

    mockInput.pressKey("s", { ctrl: true })
    expect(calls).toEqual(["save"])
  })

  test("keeps emacs syntax unavailable until the addon is registered", () => {
    const actionMap = getActionMap(renderer)
    const errors: string[] = []

    actionMap.on("error", (event) => {
      errors.push(event.message)
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "ctrl+x ctrl+s", cmd() {} }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
    expect(actionMap.getActiveKeys()).toEqual([])
  })

  test("can be disposed to restore default parsing behavior", () => {
    const actionMap = getActionMap(renderer)
    const errors: string[] = []

    const offEmacsBindings = registerEmacsBindings(actionMap)
    offEmacsBindings()

    actionMap.on("error", (event) => {
      errors.push(event.message)
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "ctrl+x ctrl+s", cmd() {} }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
    expect(actionMap.getActiveKeys()).toEqual([])
  })
})
