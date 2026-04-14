import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
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

  test("adds canonical bindings from layer-local aliases", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    registerAliasesField(manager)
    manager.registerCommands([
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      aliases: { myenter: "return" },
      bindings: [{ key: "myenter", cmd: "submit" }],
    })

    mockInput.pressEnter()

    const activeKey = manager.getActiveKeys().find((candidate) => candidate.stroke.name === "return")
    expect(activeKey).toBeDefined()
    expect(calls).toEqual(["submit"])
  })

  test("supports enter-style aliases without core alias parsing", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    registerAliasesField(manager)
    manager.registerCommands([
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [{ key: "enter", cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["submit"])
  })

  test("aliases add bindings instead of replacing the original binding", () => {
    const manager = getKeymapManager(renderer)

    registerAliasesField(manager)
    manager.registerCommands([{ name: "submit", run() {} }])
    manager.registerLayer({
      scope: "global",
      aliases: { enter: "return" },
      bindings: [{ key: "enter", cmd: "submit" }],
    })

    const names = manager.getActiveKeys().map((candidate) => candidate.stroke.name)

    expect(names).toContain("enter")
    expect(names).toContain("return")
  })

  test("aliases stay local to the layer that declared them", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    registerAliasesField(manager)
    manager.registerCommands([
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
    manager.registerLayer({
      scope: "global",
      aliases: { myenter: "return" },
      bindings: [{ key: "myenter", cmd: "aliased" }],
    })
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "myenter", cmd: "plain", consume: false }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["aliased"])
    expect(manager.getPendingSequenceParts()).toEqual([])
  })
})
