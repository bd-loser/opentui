import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../../../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { registerExCommands } from "./ex-commands.js"

let renderer: TestRenderer
let mockInput: MockInput

function createFocusableBox(id: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    width: 10,
    height: 4,
    focusable: true,
  })
}

describe("ex commands addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("supports aliases and nargs validation", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "fallback",
        run() {
          calls.push("fallback")
        },
      },
    ])

    registerExCommands(manager, [
      {
        name: "write",
        aliases: ["w"],
        nargs: "1",
        run({ args }) {
          calls.push(`write:${args.join(",")}`)
        },
      },
    ])

    const target = createFocusableBox("ex-target")
    renderer.root.add(target)

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "x", cmd: "fallback" },
        { key: "y", cmd: ":w file.txt" },
      ],
    })

    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: ":write" }],
    })

    target.focus()
    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["fallback", "write:file.txt"])
  })
})
