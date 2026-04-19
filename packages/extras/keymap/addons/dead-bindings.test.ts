import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { KeyEvent, Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import { addons, type Keymap, type WarningEvent } from "../index.js"
import { getKeymap } from "../opentui.js"

let renderer: TestRenderer
let mockInput: MockInput

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>

function captureWarnings(keymap: OpenTuiKeymap): { events: WarningEvent[]; warnings: string[] } {
  const events: WarningEvent[] = []
  const warnings: string[] = []
  keymap.on("warning", (event) => {
    events.push(event)
    warnings.push(event.message)
  })
  return { events, warnings }
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
    const { events, warnings } = captureWarnings(keymap)
    addons.registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "x" }],
    })

    expect(warnings).toEqual([
      '[Keymap] Binding "x" in global layer has no command and no reachable continuations; it will never trigger',
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      code: "dead-binding",
      warning: {
        binding: { key: "x" },
        scope: "global",
        target: undefined,
      },
    })
  })

  test("does not warn for metadata-only prefix bindings", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)
    addons.registerDeadBindingWarnings(keymap)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "g" }, { key: "gd", cmd: () => {} }],
    })

    expect(warnings).toEqual([])
  })

  test("warns for release bindings without commands", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)
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
    const { warnings } = captureWarnings(keymap)
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
    const { warnings } = captureWarnings(keymap)
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
