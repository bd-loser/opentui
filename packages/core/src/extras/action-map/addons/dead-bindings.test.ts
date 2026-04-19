import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { addons, getActionMap, type ActionMap } from "../index.js"

let renderer: TestRenderer
let mockInput: MockInput

function captureWarnings(actionMap: ActionMap): string[] {
  const warnings: string[] = []
  actionMap.on("warning", (event) => {
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
    const actionMap = getActionMap(renderer)
    const warnings = captureWarnings(actionMap)
    addons.registerDeadBindingWarnings(actionMap)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x" }],
    })

    expect(warnings).toEqual([
      '[ActionMap] Binding "x" in global layer has no command and no reachable continuations; it will never trigger',
    ])
  })

  test("does not warn for metadata-only prefix bindings", () => {
    const actionMap = getActionMap(renderer)
    const warnings = captureWarnings(actionMap)
    addons.registerDeadBindingWarnings(actionMap)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "g" }, { key: "gd", cmd: () => {} }],
    })

    expect(warnings).toEqual([])
  })

  test("warns for release bindings without commands", () => {
    const actionMap = getActionMap(renderer)
    const warnings = captureWarnings(actionMap)
    addons.registerDeadBindingWarnings(actionMap)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", event: "release" }],
    })

    expect(warnings).toEqual([
      '[ActionMap] Binding "x" in global layer has no command and no reachable continuations; it will never trigger',
    ])
  })

  test("deduplicates warnings across token recompilation", () => {
    const actionMap = getActionMap(renderer)
    const warnings = captureWarnings(actionMap)
    addons.registerDeadBindingWarnings(actionMap)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>x" }],
    })

    actionMap.registerToken({ name: "<leader>", key: { name: "space" } })

    expect(warnings).toEqual([
      '[ActionMap] Unknown token "<leader>" in key sequence "<leader>x" was ignored',
      '[ActionMap] Binding "x" in global layer has no command and no reachable continuations; it will never trigger',
    ])
  })

  test("does not affect dispatch for real command bindings", () => {
    const actionMap = getActionMap(renderer)
    const warnings = captureWarnings(actionMap)
    const calls: string[] = []

    addons.registerDeadBindingWarnings(actionMap)
    actionMap.registerLayer({
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
