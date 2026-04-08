import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../testing.js"
import { getKeymapManager, type KeymapManager } from "./index.js"

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

function getActiveKey(
  manager: KeymapManager,
  name: string,
): ReturnType<KeymapManager["getActiveKeys"]>[number] | undefined {
  return manager.getActiveKeys().find((candidate) => candidate.stroke.name === name)
}

function getActiveKeyNames(manager: KeymapManager): string[] {
  return manager
    .getActiveKeys()
    .map((candidate) => candidate.stroke.name)
    .sort()
}

describe("keymap", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("returns the same manager for the same renderer", () => {
    const first = getKeymapManager(renderer)
    const second = getKeymapManager(renderer)

    expect(first).toBe(second)
  })

  test("creates a fresh manager after manual destroy", () => {
    const first = getKeymapManager(renderer)
    first.destroy()

    const second = getKeymapManager(renderer)
    expect(second).not.toBe(first)
  })

  test("matches a target layer by default with focus-within semantics", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const parent = createFocusableBox("parent")
    const child = createFocusableBox("child")
    parent.add(child)
    renderer.root.add(parent)

    manager.registerCommands([
      {
        name: "parent-action",
        run() {
          calls.push("parent")
        },
      },
    ])

    manager.registerLayer({
      target: parent,
      bindings: [{ key: "x", cmd: "parent-action" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["parent"])
  })

  test("does not match focus-only layers for focused descendants", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const parent = createFocusableBox("focus-parent")
    const child = createFocusableBox("focus-child")
    parent.add(child)
    renderer.root.add(parent)

    manager.registerCommands([
      {
        name: "focus-only",
        run() {
          calls.push("focus-only")
        },
      },
    ])

    manager.registerLayer({
      target: parent,
      scope: "focus",
      bindings: [{ key: "x", cmd: "focus-only" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })

  test("prefers local layers over global ones and supports fallthrough", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const target = createFocusableBox("target")
    renderer.root.add(target)

    manager.registerCommands([
      {
        name: "global-action",
        run() {
          calls.push("global")
        },
      },
      {
        name: "local-action",
        run() {
          calls.push("local")
        },
      },
      {
        name: "fallthrough-action",
        run() {
          calls.push("fallthrough-local")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "x", cmd: "global-action" },
        { key: "y", cmd: "global-action" },
      ],
    })

    manager.registerLayer({
      target,
      bindings: [
        { key: "x", cmd: "local-action" },
        { key: "y", cmd: "fallthrough-action", fallthrough: true },
      ],
    })

    target.focus()

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["local", "fallthrough-local", "global"])
  })

  test("consumes matched keys by default", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let laterGlobalCount = 0
    let renderableCount = 0

    const target = createFocusableBox("consumed-target")
    target.onKeyDown = () => {
      renderableCount += 1
    }
    renderer.root.add(target)

    renderer.keyInput.on("keypress", () => {
      laterGlobalCount += 1
    })

    manager.registerCommands([
      {
        name: "consume",
        run() {
          calls.push("keymap")
        },
      },
    ])

    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "consume" }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["keymap"])
    expect(laterGlobalCount).toBe(0)
    expect(renderableCount).toBe(0)
  })

  test("consume false lets the focused renderable keep handling the key", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let laterGlobalCount = 0
    let renderableCount = 0

    const target = createFocusableBox("passthrough-target")
    target.onKeyDown = () => {
      renderableCount += 1
    }
    renderer.root.add(target)

    renderer.keyInput.on("keypress", () => {
      laterGlobalCount += 1
    })

    manager.registerCommands([
      {
        name: "passthrough",
        run() {
          calls.push("keymap")
        },
      },
    ])

    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "passthrough", consume: false }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["keymap"])
    expect(laterGlobalCount).toBe(1)
    expect(renderableCount).toBe(1)
  })

  test("supports layer enabled predicates", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let enabled = false

    manager.registerCommands([
      {
        name: "layer-command",
        run() {
          calls.push("layer")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      enabled: () => enabled,
      bindings: [{ key: "x", cmd: "layer-command" }],
    })

    mockInput.pressKey("x")
    enabled = true
    mockInput.pressKey("x")

    expect(calls).toEqual(["layer"])
  })

  test("supports object shorthand bindings", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "shorthand",
        run() {
          calls.push("shorthand")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: {
        x: "shorthand",
      },
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["shorthand"])
  })

  test("throws when duplicate command names are registered", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([{ name: "dup", run() {} }])

    expect(() => {
      manager.registerCommands([{ name: "dup", run() {} }])
    }).toThrow('Keymap command "dup" is already registered')
  })

  test("supports typed binding fields through key input hooks", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    manager.onKeyInput(({ event, setData }) => {
      if (event.name === "x") {
        setData("vim.mode", "normal")
      }
    })

    manager.registerCommands([
      {
        name: "typed-field",
        run() {
          calls.push("field")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", mode: "normal", cmd: "typed-field" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["field"])
    expect(manager.getData("vim.mode")).toBe("normal")
  })

  test("supports multi-key sequences and reports active continuation keys", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "delete-line",
        run() {
          calls.push("delete-line")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    expect(getActiveKeyNames(manager)).toEqual(["d"])

    mockInput.pressKey("d")

    expect(manager.getPendingSequence()).toEqual([{ name: "d", ctrl: false, shift: false, meta: false, super: false }])
    expect(getActiveKeyNames(manager)).toEqual(["d"])
    expect(getActiveKey(manager, "d")?.commands.map((command) => command.input)).toEqual(["delete-line"])

    mockInput.pressKey("d")

    expect(calls).toEqual(["delete-line"])
    expect(manager.getPendingSequence()).toEqual([])
  })

  test("supports token aliases inside longer sequences", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerToken({
      token: "<leader>",
      key: { name: "x", ctrl: true },
    })

    manager.registerCommands([
      {
        name: "go-definition",
        run() {
          calls.push("go-definition")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>gd", cmd: "go-definition" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(getActiveKeyNames(manager)).toEqual(["g"])
    expect(getActiveKey(manager, "g")?.commands.map((command) => command.input)).toEqual(["go-definition"])

    mockInput.pressKey("g")

    expect(getActiveKeyNames(manager)).toEqual(["d"])
    expect(getActiveKey(manager, "d")?.commands.map((command) => command.input)).toEqual(["go-definition"])

    mockInput.pressKey("d")

    expect(calls).toEqual(["go-definition"])
  })

  test("supports branching sequences", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "delete-a",
        run() {
          calls.push("da")
        },
      },
      {
        name: "delete-b",
        run() {
          calls.push("db")
        },
      },
      {
        name: "delete-ca",
        run() {
          calls.push("dca")
        },
      },
      {
        name: "delete-cb",
        run() {
          calls.push("dcb")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "da", cmd: "delete-a" },
        { key: "db", cmd: "delete-b" },
        { key: "dca", cmd: "delete-ca" },
        { key: "dcb", cmd: "delete-cb" },
      ],
    })

    mockInput.pressKey("d")
    expect(getActiveKeyNames(manager)).toEqual(["a", "b", "c"])

    mockInput.pressKey("c")
    expect(getActiveKeyNames(manager)).toEqual(["a", "b"])

    mockInput.pressKey("b")
    expect(calls).toEqual(["dcb"])
    expect(manager.getPendingSequence()).toEqual([])
  })

  test("keeps pending sequences local to the layer that captured them", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const target = createFocusableBox("sequence-target")
    renderer.root.add(target)

    manager.registerCommands([
      {
        name: "local-delete",
        run() {
          calls.push("local")
        },
      },
      {
        name: "global-delete",
        run() {
          calls.push("global")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "da", cmd: "global-delete" }],
    })

    manager.registerLayer({
      target,
      bindings: [{ key: "dd", cmd: "local-delete" }],
    })

    target.focus()
    mockInput.pressKey("d")

    expect(getActiveKeyNames(manager)).toEqual(["d"])

    mockInput.pressKey("d")

    expect(calls).toEqual(["local"])
  })

  test("supports addon-style backspace editing for pending sequences", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "delete-ca",
        run() {
          calls.push("delete-ca")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    manager.onKeyInput(({ event, consume }) => {
      if (event.name !== "backspace") {
        return
      }

      if (!manager.popPendingSequence()) {
        return
      }

      consume()
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")

    expect(manager.getPendingSequence()).toEqual([
      { name: "d", ctrl: false, shift: false, meta: false, super: false },
      { name: "c", ctrl: false, shift: false, meta: false, super: false },
    ])

    mockInput.pressBackspace()

    expect(manager.getPendingSequence()).toEqual([{ name: "d", ctrl: false, shift: false, meta: false, super: false }])
    expect(getActiveKeyNames(manager)).toEqual(["c"])

    mockInput.pressKey("c")
    mockInput.pressKey("a")

    expect(calls).toEqual(["delete-ca"])
  })

  test("clears pending sequences on invalid continuation", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")
    expect(manager.getPendingSequence()).toHaveLength(1)

    mockInput.pressKey("x")

    expect(manager.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(manager)).toEqual(["d"])
  })

  test("getActiveKeys respects runtime requirements", () => {
    const manager = getKeymapManager(renderer)

    manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    manager.registerCommands([
      { name: "normal-delete", run() {} },
      { name: "visual-delete", run() {} },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", mode: "normal", cmd: "normal-delete" },
        { key: "vv", mode: "visual", cmd: "visual-delete" },
      ],
    })

    expect(getActiveKeyNames(manager)).toEqual([])

    manager.setData("vim.mode", "normal")
    expect(getActiveKeyNames(manager)).toEqual(["d"])

    manager.setData("vim.mode", "visual")
    expect(getActiveKeyNames(manager)).toEqual(["v"])
  })

  test("throws on conflicting requirements from typed fields", () => {
    const manager = getKeymapManager(renderer)

    manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
      state(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", mode: "normal", state: "visual", cmd: "noop" }],
      })
    }).toThrow('Conflicting keymap requirement for "vim.mode"')
  })

  test("throws on unknown binding fields", () => {
    const manager = getKeymapManager(renderer)

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", mode: "normal", cmd: "noop" }],
      })
    }).toThrow('Unknown keymap binding field "mode"')
  })

  test("throws when a binding is both an exact key and a prefix", () => {
    const manager = getKeymapManager(renderer)

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [
          { key: "d", cmd: "one" },
          { key: "dd", cmd: "two" },
        ],
      })
    }).toThrow("Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer")
  })

  test("supports raw input hooks and stop semantics", () => {
    const manager = getKeymapManager(renderer)
    const rawCalls: string[] = []
    const keyCalls: string[] = []

    manager.onRawInput(({ sequence, stop }) => {
      rawCalls.push(sequence)
      stop()
    })

    renderer.keyInput.on("keypress", (event) => {
      keyCalls.push(event.name)
    })

    renderer.stdin.emit("data", Buffer.from("x"))

    expect(rawCalls).toEqual(["x"])
    expect(keyCalls).toEqual([])
  })

  test("supports release hooks", async () => {
    renderer.destroy()
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput

    const manager = getKeymapManager(renderer)
    const events: string[] = []

    manager.onKeyInput(
      ({ event }) => {
        events.push(`${event.name}:${event.eventType}`)
      },
      { release: true },
    )

    renderer.stdin.emit("data", Buffer.from("\x1b[97;1:3u"))

    expect(events).toEqual(["a:release"])
  })

  test("ignores destroyed target layers and lets lower layers continue", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "local",
        run() {
          calls.push("local")
        },
      },
      {
        name: "global",
        run() {
          calls.push("global")
        },
      },
    ])

    const target = createFocusableBox("destroy-target")
    renderer.root.add(target)

    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "global" }],
    })

    target.destroy()
    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
  })

  test("passes target, args, and runtime data to commands", () => {
    const manager = getKeymapManager(renderer)
    const seen: Array<{ target: string; args: string; mode: string }> = []

    manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    manager.onKeyInput(({ event, setData }) => {
      if (event.name === "x") {
        setData("vim.mode", "normal")
      }
    })

    manager.registerCommands([
      {
        name: "record",
        run(ctx) {
          seen.push({
            target: ctx.target?.id ?? "none",
            args: ctx.command.args.join(","),
            mode: String(ctx.data["vim.mode"]),
          })
        },
      },
    ])

    const parent = createFocusableBox("ctx-parent")
    const child = createFocusableBox("ctx-child")
    parent.add(child)
    renderer.root.add(parent)

    manager.registerLayer({
      target: parent,
      bindings: [{ key: "x", mode: "normal", cmd: "record one two" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(seen).toEqual([{ target: "ctx-parent", args: "one,two", mode: "normal" }])
  })
})
