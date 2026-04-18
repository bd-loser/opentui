import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getActionMap } from "../index.js"
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
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    registerEscapeClearsPendingSequence(actionMap)

    mockInput.pressKey("d")
    expect(actionMap.hasPendingSequence()).toBe(true)
    expect(actionMap.getPendingSequence()).toEqual([
      { name: "d", ctrl: false, shift: false, meta: false, super: false },
    ])

    mockInput.pressEscape()

    expect(actionMap.hasPendingSequence()).toBe(false)
    expect(actionMap.getPendingSequence()).toEqual([])
    expect(calls).toEqual([])

    mockInput.pressEscape()

    expect(calls).toEqual(["escape"])
  })

  test("can clear pending sequence without consuming escape", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    registerEscapeClearsPendingSequence(actionMap, { preventDefault: false })

    mockInput.pressKey("d")
    expect(actionMap.hasPendingSequence()).toBe(true)
    mockInput.pressEscape()

    expect(actionMap.hasPendingSequence()).toBe(false)
    expect(actionMap.getPendingSequence()).toEqual([])
    expect(calls).toEqual(["escape"])
  })

  test("can be disposed to stop pending escape forwarding behavior", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", cmd: "delete-line" },
        { key: "escape", cmd: "escape-command" },
      ],
    })

    const offEscapeAddon = registerEscapeClearsPendingSequence(actionMap, { preventDefault: false })

    mockInput.pressKey("d")
    mockInput.pressEscape()
    expect(calls).toEqual(["escape"])

    mockInput.pressKey("d")
    offEscapeAddon()
    mockInput.pressEscape()

    expect(actionMap.hasPendingSequence()).toBe(false)
    expect(calls).toEqual(["escape"])
  })
})
