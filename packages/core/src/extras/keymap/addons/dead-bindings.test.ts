import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { addons, getKeymap, type Keymap } from "../index.js"

let renderer: TestRenderer
let mockInput: MockInput

function captureWarnings(keymap: Keymap): string[] {
  const warnings: string[] = []
  keymap.on("warning", (event) => {
    warnings.push(event.message)
  })
  return warnings
}

describe("dead binding warnings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 12 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("warns when an exact binding has no command and no reachable continuations", () => {
    const keymap = getKeymap(renderer)
    const warnings = captureWarnings(keymap)
    addons.registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "x" }],
    })

    expect(warnings).toEqual([
      '[Keymap] Binding "x" in global layer has no command and no reachable continuations; it will never trigger',
    ])
  })

  test("does not warn for metadata-only prefix bindings", () => {
    const keymap = getKeymap(renderer)
    const warnings = captureWarnings(keymap)
    addons.registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "g" }, { key: "gd", cmd: () => {} }],
    })

    expect(warnings).toEqual([])
  })

  test("warns for release bindings without commands", () => {
    const keymap = getKeymap(renderer)
    const warnings = captureWarnings(keymap)
    addons.registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", event: "release" }],
    })

    expect(warnings).toEqual([
      '[Keymap] Binding "x" in global layer has no command and no reachable continuations; it will never trigger',
    ])
  })

  test("deduplicates warnings across token recompilation", () => {
    const keymap = getKeymap(renderer)
    const warnings = captureWarnings(keymap)
    addons.registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>x" }],
    })

    keymap.registerToken({ name: "<leader>", key: { name: "space" } })

    expect(warnings).toEqual([
      '[Keymap] Unknown token "<leader>" in key sequence "<leader>x" was ignored',
      '[Keymap] Binding "x" in global layer has no command and no reachable continuations; it will never trigger',
    ])
  })

  test("does not affect dispatch for real command bindings", () => {
    const keymap = getKeymap(renderer)
    const warnings = captureWarnings(keymap)
    const calls: string[] = []

    addons.registerDeadBindingWarnings(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "run",
          run() {
            calls.push("run")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "run" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["run"])
    expect(warnings).toEqual([])
  })
})
