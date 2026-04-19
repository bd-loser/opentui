import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getActionMap } from "../index.js"
import { registerBackspacePopsPendingSequence } from "./backspace-pops-pending-sequence.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("backspace pops pending sequence addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("pops pending sequence on backspace and only intercepts while pending", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "delete-ca",
          run() {
            calls.push("delete")
          },
        },
        {
          name: "backspace-command",
          run() {
            calls.push("backspace")
          },
        },
      ],
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dca", cmd: "delete-ca" },
        { key: "backspace", cmd: "backspace-command" },
      ],
    })

    registerBackspacePopsPendingSequence(actionMap)

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    expect(actionMap.getPendingSequence()).toEqual([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
        matchKey: "d:0:0:0:0:0",
      },
      {
        stroke: { name: "c", ctrl: false, shift: false, meta: false, super: false },
        display: "c",
        matchKey: "c:0:0:0:0:0",
      },
    ])

    mockInput.pressBackspace()

    expect(actionMap.getPendingSequence()).toEqual([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
        matchKey: "d:0:0:0:0:0",
      },
    ])
    expect(calls).toEqual([])

    mockInput.pressBackspace()
    expect(actionMap.getPendingSequence()).toEqual([])
    expect(calls).toEqual([])

    mockInput.pressBackspace()
    expect(calls).toEqual(["backspace"])
  })

  test("can pop pending sequence without consuming backspace", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "delete-ca",
          run() {},
        },
        {
          name: "backspace-command",
          run() {},
        },
      ],
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dca", cmd: "delete-ca" },
        { key: "backspace", cmd: "backspace-command" },
      ],
    })

    registerBackspacePopsPendingSequence(actionMap, { preventDefault: false })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    mockInput.pressBackspace()

    expect(actionMap.hasPendingSequence()).toBe(false)
  })

  test("can be disposed to stop backspace pop behavior", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "backspace-command",
          run() {},
        },
      ],
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", cmd: () => {} },
        { key: "backspace", cmd: "backspace-command" },
      ],
    })

    const offAddon = registerBackspacePopsPendingSequence(actionMap, { preventDefault: false })

    mockInput.pressKey("d")
    offAddon()
    mockInput.pressBackspace()

    expect(actionMap.hasPendingSequence()).toBe(false)
  })
})
