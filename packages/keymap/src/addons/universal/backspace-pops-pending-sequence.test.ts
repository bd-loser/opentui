import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { registerBackspacePopsPendingSequence } from "@opentui/keymap/addons"
import { createDefaultOpenTuiKeymap as getKeymap } from "@opentui/keymap/opentui"

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
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
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

    keymap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dca", cmd: "delete-ca" },
        { key: "backspace", cmd: "backspace-command" },
      ],
    })

    registerBackspacePopsPendingSequence(keymap)

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    expect(keymap.getPendingSequence()).toMatchObject([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
      {
        stroke: { name: "c", ctrl: false, shift: false, meta: false, super: false },
        display: "c",
      },
    ])

    mockInput.pressBackspace()

    expect(keymap.getPendingSequence()).toMatchObject([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
    ])
    expect(calls).toEqual([])

    mockInput.pressBackspace()
    expect(keymap.getPendingSequence()).toEqual([])
    expect(calls).toEqual([])

    mockInput.pressBackspace()
    expect(calls).toEqual(["backspace"])
  })

  test("can pop pending sequence without consuming backspace", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
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

    keymap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dca", cmd: "delete-ca" },
        { key: "backspace", cmd: "backspace-command" },
      ],
    })

    registerBackspacePopsPendingSequence(keymap, { preventDefault: false })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    mockInput.pressBackspace()

    expect(keymap.hasPendingSequence()).toBe(false)
  })

  test("can be disposed to stop backspace pop behavior", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "backspace-command",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", cmd: () => {} },
        { key: "backspace", cmd: "backspace-command" },
      ],
    })

    const offAddon = registerBackspacePopsPendingSequence(keymap, { preventDefault: false })

    mockInput.pressKey("d")
    offAddon()
    mockInput.pressBackspace()

    expect(keymap.hasPendingSequence()).toBe(false)
  })
})
