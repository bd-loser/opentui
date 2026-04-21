import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { KeyEvent, Renderable } from "@opentui/core"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { registerUnresolvedCommandWarnings } from "@opentui/keymap/addons"
import type { Keymap, WarningEvent } from "@opentui/keymap"
import { getKeymap } from "@opentui/keymap/opentui"

let renderer: TestRenderer

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

describe("unresolved command warnings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 12 })
    renderer = testSetup.renderer
  })

  afterEach(() => {
    renderer.destroy()
  })

  test("warns when a binding references an unresolved string command", () => {
    const keymap = getKeymap(renderer)
    const { events, warnings } = captureWarnings(keymap)

    registerUnresolvedCommandWarnings(keymap)
    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "missing-command" }],
    })

    expect(warnings).toEqual(['[Keymap] Unresolved command "missing-command" for binding "x" in global layer'])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      code: "unresolved-command",
      warning: {
        command: "missing-command",
        scope: "global",
        target: undefined,
        binding: {
          cmd: "missing-command",
          key: "x",
        },
      },
    })
  })

  test("does not warn for same-layer local commands", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)

    registerUnresolvedCommandWarnings(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [{ name: "local-run", run() {} }],
      bindings: [{ key: "x", cmd: "local-run" }],
    })

    expect(warnings).toEqual([])
  })

  test("does not warn when a command resolver resolves the binding command", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)

    registerUnresolvedCommandWarnings(keymap)
    keymap.appendCommandResolver((command) => {
      if (command !== "resolved-by-resolver") {
        return undefined
      }

      return { run() {} }
    })
    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "resolved-by-resolver" }],
    })

    expect(warnings).toEqual([])
  })

  test("deduplicates warnings across token-driven recompilation", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureWarnings(keymap)

    registerUnresolvedCommandWarnings(keymap)
    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>x", cmd: "missing-command" }],
    })

    keymap.registerToken({ name: "<leader>", key: { name: "space" } })

    expect(warnings).toEqual([
      '[Keymap] Unknown token "<leader>" in key sequence "<leader>x" was ignored',
      '[Keymap] Unresolved command "missing-command" for binding "x" in global layer',
    ])
  })
})
