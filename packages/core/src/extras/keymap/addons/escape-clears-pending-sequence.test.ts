import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { registerEscapeClearsPendingSequence } from "./escape-clears-pending-sequence.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("escape clears pending sequence addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("clears pending sequence on escape and only intercepts escape while pending", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "delete-line",
        run() {
          calls.push("delete")
        },
      },
      {
        name: "escape-command",
        run() {
          calls.push("escape")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    registerEscapeClearsPendingSequence(manager)

    mockInput.pressKey("d")
    expect(manager.hasPendingSequence()).toBe(true)
    expect(manager.getPendingSequence()).toEqual([{ name: "d", ctrl: false, shift: false, meta: false, super: false }])

    mockInput.pressEscape()

    expect(manager.hasPendingSequence()).toBe(false)
    expect(manager.getPendingSequence()).toEqual([])
    expect(calls).toEqual([])

    mockInput.pressEscape()

    expect(calls).toEqual(["escape"])
  })

  test("can clear pending sequence without consuming escape", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "delete-line",
        run() {
          calls.push("delete")
        },
      },
      {
        name: "escape-command",
        run() {
          calls.push("escape")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    registerEscapeClearsPendingSequence(manager, { consume: false })

    mockInput.pressKey("d")
    expect(manager.hasPendingSequence()).toBe(true)
    mockInput.pressEscape()

    expect(manager.hasPendingSequence()).toBe(false)
    expect(manager.getPendingSequence()).toEqual([])
    expect(calls).toEqual(["escape"])
  })

  test("can be disposed to stop pending escape forwarding behavior", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "delete-line",
        run() {
          calls.push("delete")
        },
      },
      {
        name: "escape-command",
        run() {
          calls.push("escape")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    const offEscapeAddon = registerEscapeClearsPendingSequence(manager, { consume: false })

    mockInput.pressKey("d")
    mockInput.pressEscape()
    expect(calls).toEqual(["escape"])

    mockInput.pressKey("d")
    offEscapeAddon()
    mockInput.pressEscape()

    expect(manager.hasPendingSequence()).toBe(false)
    expect(calls).toEqual(["escape"])
  })
})
