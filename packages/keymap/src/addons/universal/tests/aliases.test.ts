import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { stringifyKeyStroke } from "@opentui/keymap"
import { registerAliasesField } from "@opentui/keymap/addons"
import { createDefaultOpenTuiKeymap as getKeymap } from "@opentui/keymap/opentui"

let renderer: TestRenderer
let mockInput: MockInput

describe("aliases field addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("adds canonical bindings from already-parsed alias strokes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerAliasesField(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      aliases: { myenter: "return" },
      bindings: [{ key: { name: "myenter" }, cmd: "submit" }],
    })

    mockInput.pressEnter()

    const activeKey = keymap.getActiveKeys().find((candidate) => candidate.stroke.name === "return")
    expect(activeKey).toBeDefined()
    expect(calls).toEqual(["submit"])
  })

  test("supports enter-style aliases for object key bindings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerAliasesField(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [{ key: { name: "enter" }, cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["submit"])
  })

  test("aliases add bindings instead of replacing the original binding", () => {
    const keymap = getKeymap(renderer)

    registerAliasesField(keymap)
    keymap.registerLayer({ scope: "global", commands: [{ name: "submit", run() {} }] })
    keymap.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [{ key: { name: "enter" }, cmd: "submit" }],
    })

    const names = keymap.getActiveKeys().map((candidate) => candidate.stroke.name)

    expect(names).toContain("enter")
    expect(names).toContain("return")
  })

  test("aliases stay local to the layer that declared them", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerAliasesField(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "aliased",
          run() {
            calls.push("aliased")
          },
        },
        {
          name: "plain",
          run() {
            calls.push("plain")
          },
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      aliases: { myenter: "return" },
      bindings: [{ key: { name: "myenter" }, cmd: "aliased" }],
    })
    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: { name: "myenter" }, cmd: "plain", preventDefault: false }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["aliased"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("can be disposed to stop alias expansion for subsequent layers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const offAliases = registerAliasesField(keymap)
    offAliases()

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [{ key: { name: "enter" }, cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual([])
    expect(keymap.getActiveKeys().some((candidate) => candidate.stroke.name === "enter")).toBe(true)
    expect(keymap.getActiveKeys().some((candidate) => candidate.stroke.name === "return")).toBe(false)
  })

  test("keeps the first preserved alias label when canonical and alias labels collide", () => {
    const keymap = getKeymap(renderer)

    registerAliasesField(keymap)

    keymap.registerLayer({
      scope: "global",
      commands: [
        { name: "submit-enter", run() {} },
        { name: "submit-return", run() {} },
      ],
    })

    keymap.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [
        { key: { name: "enter" }, cmd: "submit-enter" },
        { key: "return", cmd: "submit-return" },
      ],
    })

    const activeEnter = keymap.getActiveKeys().find((candidate) => candidate.stroke.name === "return")
    expect(activeEnter?.display).toBe("enter")
    expect(stringifyKeyStroke(activeEnter!, { preferDisplay: true })).toBe("enter")
  })
})
