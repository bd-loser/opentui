import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getActionMap, stringifyKeyStroke } from "../index.js"
import { registerAliasesField } from "./aliases.js"

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
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    registerAliasesField(actionMap)
    actionMap.registerCommands([
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ])
    actionMap.registerLayer({
      scope: "global",
      aliases: { myenter: "return" },
      bindings: [{ key: { name: "myenter" }, cmd: "submit" }],
    })

    mockInput.pressEnter()

    const activeKey = actionMap.getActiveKeys().find((candidate) => candidate.stroke.name === "return")
    expect(activeKey).toBeDefined()
    expect(calls).toEqual(["submit"])
  })

  test("supports enter-style aliases for object key bindings", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    registerAliasesField(actionMap)
    actionMap.registerCommands([
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ])
    actionMap.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [{ key: { name: "enter" }, cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["submit"])
  })

  test("aliases add bindings instead of replacing the original binding", () => {
    const actionMap = getActionMap(renderer)

    registerAliasesField(actionMap)
    actionMap.registerCommands([{ name: "submit", run() {} }])
    actionMap.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [{ key: { name: "enter" }, cmd: "submit" }],
    })

    const names = actionMap.getActiveKeys().map((candidate) => candidate.stroke.name)

    expect(names).toContain("enter")
    expect(names).toContain("return")
  })

  test("aliases stay local to the layer that declared them", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    registerAliasesField(actionMap)
    actionMap.registerCommands([
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
    ])
    actionMap.registerLayer({
      scope: "global",
      aliases: { myenter: "return" },
      bindings: [{ key: { name: "myenter" }, cmd: "aliased" }],
    })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: { name: "myenter" }, cmd: "plain", preventDefault: false }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["aliased"])
    expect(actionMap.getPendingSequenceParts()).toEqual([])
  })

  test("can be disposed to stop alias expansion for subsequent layers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const offAliases = registerAliasesField(actionMap)
    offAliases()

    actionMap.registerCommands([
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ])
    actionMap.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [{ key: { name: "enter" }, cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual([])
    expect(actionMap.getActiveKeys().some((candidate) => candidate.stroke.name === "enter")).toBe(true)
    expect(actionMap.getActiveKeys().some((candidate) => candidate.stroke.name === "return")).toBe(false)
  })

  test("keeps the first preserved alias label when canonical and alias labels collide", () => {
    const actionMap = getActionMap(renderer)

    registerAliasesField(actionMap)

    actionMap.registerCommands([
      { name: "submit-enter", run() {} },
      { name: "submit-return", run() {} },
    ])

    actionMap.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [
        { key: { name: "enter" }, cmd: "submit-enter" },
        { key: "return", cmd: "submit-return" },
      ],
    })

    const activeEnter = actionMap.getActiveKeys().find((candidate) => candidate.stroke.name === "return")
    expect(activeEnter?.display).toBe("enter")
    expect(stringifyKeyStroke(activeEnter!, { preferDisplay: true })).toBe("enter")
  })
})
