import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../testing.js"
import {
  getKeymapManager,
  parseKeySequenceLike,
  stringifyKeySequence,
  stringifyKeyStroke,
  type KeymapManager,
} from "./index.js"

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
  options?: Parameters<KeymapManager["getActiveKeys"]>[0],
): ReturnType<KeymapManager["getActiveKeys"]>[number] | undefined {
  return manager.getActiveKeys(options).find((candidate) => candidate.stroke.name === name)
}

function getActiveKeyNames(manager: KeymapManager): string[] {
  return manager
    .getActiveKeys()
    .map((candidate) => candidate.stroke.name)
    .sort()
}

function getActiveKeyDisplay(
  manager: KeymapManager,
  display: string,
  options?: Parameters<KeymapManager["getActiveKeys"]>[0],
): ReturnType<KeymapManager["getActiveKeys"]>[number] | undefined {
  return manager.getActiveKeys(options).find((candidate) => candidate.display === display)
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

  test("defaults targetless layers to global scope", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "global-default",
        run() {
          calls.push("global")
        },
      },
    ])

    manager.registerLayer({
      bindings: [{ key: "x", cmd: "global-default" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
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

  test("captures display for parsed sequences and stringifies tokens on demand", () => {
    const sequence = parseKeySequenceLike(
      "<leader>dd",
      new Map([["<leader>", { name: "x", ctrl: true, shift: false, meta: false, super: false }]]),
    )

    expect(sequence).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
      },
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
    ])
    expect(stringifyKeySequence(sequence)).toBe("ctrl+xdd")
    expect(stringifyKeySequence(sequence, { preferDisplay: true })).toBe("<leader>dd")
    expect(stringifyKeyStroke(sequence[0]!)).toBe("ctrl+x")
    expect(stringifyKeyStroke(sequence[0]!, { preferDisplay: true })).toBe("<leader>")
  })

  test("preserves non-token display strings when explicitly requested", () => {
    const sequence = parseKeySequenceLike("return")

    expect(sequence).toEqual([
      {
        stroke: { name: "return", ctrl: false, shift: false, meta: false, super: false },
        display: "return",
      },
    ])
    expect(stringifyKeySequence(sequence)).toBe("enter")
    expect(stringifyKeySequence(sequence, { preferDisplay: true })).toBe("return")
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

  test("supports binding metadata attributes through typed fields", () => {
    const manager = getKeymapManager(renderer)

    manager.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
      group(value, ctx) {
        ctx.attr("group", value)
      },
    })

    manager.registerCommands([
      {
        name: "save-file",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "Save file", group: "File" }],
    })

    const activeKey = getActiveKey(manager, "x", { includeBindings: true })
    const activeBinding = activeKey?.bindings?.[0]
    expect(activeKey?.bindings).toHaveLength(1)
    expect(activeBinding?.attrs).toEqual({ desc: "Save file", group: "File" })
    expect(activeBinding?.command.attrs).toBeUndefined()
    expect(activeKey?.commands[0]?.attrs).toBeUndefined()
  })

  test("typed binding fields can emit both requirements and attributes", () => {
    const manager = getKeymapManager(renderer)
    const seen: string[] = []

    manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
        ctx.attr("mode", value)
      },
    })

    manager.registerCommands([
      {
        name: "record-mode",
        run(ctx) {
          seen.push(String(ctx.data["vim.mode"]))
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", mode: "normal", cmd: "record-mode" }],
    })

    expect(getActiveKeyNames(manager)).toEqual([])

    manager.setData("vim.mode", "normal")

    const activeKey = getActiveKey(manager, "x", { includeBindings: true })
    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ mode: "normal" })

    mockInput.pressKey("x")

    expect(seen).toEqual(["normal"])
  })

  test("typed binding fields can emit runtime matchers", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let enabled = false

    manager.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.match(() => enabled)
      },
    })

    manager.registerCommands([
      {
        name: "runtime-binding",
        run() {
          calls.push("binding")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(getActiveKeyNames(manager)).toEqual([])

    enabled = true

    expect(getActiveKeyNames(manager)).toEqual(["x"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["binding"])

    enabled = false

    expect(getActiveKeyNames(manager)).toEqual([])
  })

  test("typed binding field matchers clear pending sequences when they stop matching", () => {
    const manager = getKeymapManager(renderer)
    let enabled = true

    manager.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.match(() => enabled)
      },
    })

    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", active: true, cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(manager.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(manager.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(manager)).toEqual([])
  })

  test("treats thrown binding runtime matchers as non-matching", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.match(() => {
          throw new Error("boom")
        })
      },
    })

    manager.registerCommands([
      {
        name: "runtime-binding",
        run() {
          calls.push("binding")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(() => manager.getActiveKeys()).not.toThrow()
    expect(getActiveKeyNames(manager)).toEqual([])

    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })

  test("typed binding field matchers can use keyed invalidation", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let enabled = false
    let evaluations = 0

    manager.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.match(
          () => {
            evaluations += 1
            return enabled
          },
          { keys: ["binding.active"] },
        )
      },
    })

    manager.registerCommands([
      {
        name: "runtime-binding",
        run() {
          calls.push("binding")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(getActiveKeyNames(manager)).toEqual([])
    expect(evaluations).toBe(1)

    expect(getActiveKeyNames(manager)).toEqual([])
    expect(evaluations).toBe(1)

    manager.setData("unrelated", true)

    expect(getActiveKeyNames(manager)).toEqual([])
    expect(evaluations).toBe(1)

    enabled = true

    expect(getActiveKeyNames(manager)).toEqual([])
    expect(evaluations).toBe(1)

    manager.invalidateRuntimeKey("binding.active")

    expect(getActiveKeyNames(manager)).toEqual(["x"])
    expect(evaluations).toBe(2)

    mockInput.pressKey("x")

    expect(calls).toEqual(["binding"])

    enabled = false

    expect(getActiveKeyNames(manager)).toEqual(["x"])

    manager.invalidateRuntimeKey("binding.active")

    expect(getActiveKeyNames(manager)).toEqual([])
    expect(evaluations).toBe(3)
  })

  test("supports typed layer fields for local scopes", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    manager.registerCommands([
      {
        name: "local-mode",
        run() {
          calls.push("local")
        },
      },
    ])

    const target = createFocusableBox("layer-field-target")
    renderer.root.add(target)

    manager.registerLayer({
      target,
      mode: "normal",
      bindings: [{ key: "x", cmd: "local-mode" }],
    })

    target.focus()

    expect(getActiveKeyNames(manager)).toEqual([])

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    manager.setData("vim.mode", "normal")

    expect(getActiveKeyNames(manager)).toEqual(["x"])

    mockInput.pressKey("x")
    expect(calls).toEqual(["local"])
  })

  test("typed layer fields can emit runtime matchers", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let enabled = false

    manager.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap layer field "active" must be true')
        }

        ctx.match(() => enabled)
      },
    })

    manager.registerCommands([
      {
        name: "runtime-layer",
        run() {
          calls.push("layer")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "x", cmd: "runtime-layer" }],
    })

    expect(getActiveKeyNames(manager)).toEqual([])

    enabled = true

    expect(getActiveKeyNames(manager)).toEqual(["x"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["layer"])

    enabled = false

    expect(getActiveKeyNames(manager)).toEqual([])
  })

  test("typed layer field matchers clear pending sequences when they stop matching", () => {
    const manager = getKeymapManager(renderer)
    let enabled = true

    manager.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap layer field "active" must be true')
        }

        ctx.match(() => enabled)
      },
    })

    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(manager.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(manager.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(manager)).toEqual([])
  })

  test("typed layer field matchers clear pending sequences after keyed invalidation", () => {
    const manager = getKeymapManager(renderer)
    let enabled = true

    manager.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap layer field "active" must be true')
        }

        ctx.match(() => enabled, { keys: ["layer.active"] })
      },
    })

    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(manager.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(manager.getPendingSequence()).toHaveLength(1)

    manager.invalidateRuntimeKey("layer.active")

    expect(manager.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(manager)).toEqual([])
  })

  test("layer and binding requirements compose", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    manager.registerBindingFields({
      state(value, ctx) {
        ctx.require("vim.state", value)
      },
    })

    manager.registerCommands([
      {
        name: "composed",
        run() {
          calls.push("hit")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      mode: "normal",
      bindings: [{ key: "x", state: "idle", cmd: "composed" }],
    })

    expect(getActiveKeyNames(manager)).toEqual([])

    manager.setData("vim.mode", "normal")
    expect(getActiveKeyNames(manager)).toEqual([])

    manager.setData("vim.state", "idle")
    expect(getActiveKeyNames(manager)).toEqual(["x"])

    mockInput.pressKey("x")
    expect(calls).toEqual(["hit"])

    manager.setData("vim.mode", "visual")
    expect(getActiveKeyNames(manager)).toEqual([])
  })

  test("supports command metadata attributes in active keys and command contexts", () => {
    const manager = getKeymapManager(renderer)
    const seen: Record<string, unknown>[] = []

    manager.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
      title(value, ctx) {
        ctx.attr("title", value)
      },
      category(value, ctx) {
        ctx.attr("category", value)
      },
    })

    manager.registerCommands([
      {
        name: "save-file",
        desc: "Save the current file",
        title: "Save File",
        category: "File",
        run(ctx) {
          seen.push({ ...ctx.command.attrs })
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    const attrs = {
      desc: "Save the current file",
      title: "Save File",
      category: "File",
    }

    const activeKey = getActiveKey(manager, "x", { includeBindings: true })
    expect(activeKey?.bindings?.[0]?.command.attrs).toEqual(attrs)
    expect(activeKey?.commands[0]?.attrs).toEqual(attrs)

    mockInput.pressKey("x")

    expect(seen).toEqual([attrs])
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
    expect(manager.getPendingSequenceParts()).toEqual([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
    ])
    expect(getActiveKeyNames(manager)).toEqual(["d"])
    expect(getActiveKey(manager, "d")?.commands.map((command) => command.input)).toEqual(["delete-line"])
    expect(getActiveKey(manager, "d")?.display).toBe("d")

    mockInput.pressKey("d")

    expect(calls).toEqual(["delete-line"])
    expect(manager.getPendingSequence()).toEqual([])
  })

  test("notifies pending sequence changes synchronously", () => {
    const manager = getKeymapManager(renderer)
    const changes: string[] = []

    manager.registerCommands([
      {
        name: "delete-ca",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    manager.onPendingSequenceChange((sequence) => {
      changes.push(sequence.map((stroke) => stroke.name).join(""))
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    manager.popPendingSequence()
    manager.clearPendingSequence()

    expect(changes).toEqual(["d", "dc", "d", ""])
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
    expect(getActiveKeyDisplay(manager, "g")?.commands.map((command) => command.input)).toEqual(["go-definition"])
    expect(manager.getPendingSequenceParts()).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
      },
    ])
    expect(getActiveKey(manager, "g")?.commands.map((command) => command.input)).toEqual(["go-definition"])

    mockInput.pressKey("g")

    expect(getActiveKeyNames(manager)).toEqual(["d"])
    expect(stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true })).toBe("<leader>g")
    expect(getActiveKey(manager, "d")?.commands.map((command) => command.input)).toEqual(["go-definition"])

    mockInput.pressKey("d")

    expect(calls).toEqual(["go-definition"])
  })

  test("uses preserved display for unambiguous active token prefixes", () => {
    const manager = getKeymapManager(renderer)

    manager.registerToken({
      token: "<leader>",
      key: { name: "x", ctrl: true },
    })

    manager.registerCommands([
      { name: "save", run() {} },
      { name: "help", run() {} },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "<leader>s", cmd: "save" },
        { key: "<leader>h", cmd: "help" },
      ],
    })

    expect(getActiveKeyDisplay(manager, "<leader>")?.commands.map((command) => command.input)).toEqual(["save", "help"])
    expect(stringifyKeyStroke(getActiveKeyDisplay(manager, "<leader>")!, { preferDisplay: true })).toBe("<leader>")
  })

  test("falls back to canonical live display when the same stroke has multiple preserved labels", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([
      { name: "submit-enter", run() {} },
      { name: "submit-return", run() {} },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "enter", cmd: "submit-enter" },
        { key: "return", cmd: "submit-return" },
      ],
    })

    const activeEnter = manager.getActiveKeys().find((candidate) => candidate.stroke.name === "return")
    expect(activeEnter?.display).toBe("enter")
    expect(stringifyKeyStroke(activeEnter!, { preferDisplay: true })).toBe("enter")
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

  test("throws on conflicting requirements from typed layer fields", () => {
    const manager = getKeymapManager(renderer)

    manager.registerLayerFields({
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
        mode: "normal",
        state: "visual",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).toThrow('Conflicting keymap requirement for "vim.mode"')
  })

  test("throws on conflicting attributes from typed binding fields", () => {
    const manager = getKeymapManager(renderer)

    manager.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("label", value)
      },
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", desc: "Delete line", title: "Delete", cmd: "noop" }],
      })
    }).toThrow('Conflicting keymap attribute for "label"')
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

  test("throws on unknown layer fields", () => {
    const manager = getKeymapManager(renderer)

    expect(() => {
      manager.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).toThrow('Unknown keymap layer field "mode"')
  })

  test("throws on unknown command fields", () => {
    const manager = getKeymapManager(renderer)

    expect(() => {
      manager.registerCommands([
        {
          name: "save-file",
          desc: "Save the current file",
          run() {},
        },
      ])
    }).toThrow('Unknown keymap command field "desc"')
  })

  test("throws on reserved command field registrations", () => {
    const manager = getKeymapManager(renderer)

    expect(() => {
      manager.registerCommandFields({
        name() {},
      })
    }).toThrow('Keymap command field "name" is reserved')
  })

  test("throws on reserved layer field registrations", () => {
    const manager = getKeymapManager(renderer)

    expect(() => {
      manager.registerLayerFields({
        scope() {},
      })
    }).toThrow('Keymap layer field "scope" is reserved')
  })

  test("throws on conflicting attributes from typed command fields", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("label", value)
      },
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    expect(() => {
      manager.registerCommands([
        {
          name: "save-file",
          desc: "Save",
          title: "Write",
          run() {},
        },
      ])
    }).toThrow('Conflicting keymap attribute for "label"')
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

  test("passes fresh runtime data snapshots to commands after data changes", () => {
    const manager = getKeymapManager(renderer)
    const seen: string[] = []

    manager.registerCommands([
      {
        name: "record-mode",
        run(ctx) {
          seen.push(String(ctx.data["vim.mode"]))
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "record-mode" }],
    })

    manager.setData("vim.mode", "normal")
    mockInput.pressKey("x")

    manager.setData("vim.mode", "visual")
    mockInput.pressKey("x")

    expect(seen).toEqual(["normal", "visual"])
  })

  test("orders key hooks by priority, exposes getData, and cleans them up", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.setData("vim.mode", "normal")

    const offLow = manager.onKeyInput(
      ({ event, getData }) => {
        if (event.name !== "x") {
          return
        }

        calls.push(`low:${String(getData("vim.mode"))}`)
      },
      { priority: 1 },
    )

    manager.onKeyInput(
      ({ event }) => {
        if (event.name === "x") {
          calls.push("high:first")
        }
      },
      { priority: 10 },
    )

    manager.onKeyInput(
      ({ event }) => {
        if (event.name === "x") {
          calls.push("high:second")
        }
      },
      { priority: 10 },
    )

    mockInput.pressKey("x")

    expect(calls).toEqual(["high:first", "high:second", "low:normal"])

    offLow()
    calls.length = 0

    mockInput.pressKey("x")

    expect(calls).toEqual(["high:first", "high:second"])
  })

  test("uses a stable key hook snapshot when hooks unsubscribe mid-dispatch", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    let offSecond!: () => void

    manager.onKeyInput(
      ({ event }) => {
        if (event.name !== "x") {
          return
        }

        calls.push("first")
        offSecond()
      },
      { priority: 3 },
    )

    offSecond = manager.onKeyInput(
      ({ event }) => {
        if (event.name === "x") {
          calls.push("second")
        }
      },
      { priority: 2 },
    )

    manager.onKeyInput(
      ({ event }) => {
        if (event.name === "x") {
          calls.push("third")
        }
      },
      { priority: 1 },
    )

    mockInput.pressKey("x")
    expect(calls).toEqual(["first", "second", "third"])

    calls.length = 0
    mockInput.pressKey("x")
    expect(calls).toEqual(["first", "third"])
  })

  test("orders raw hooks by priority and cleans them up", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const offLow = manager.onRawInput(
      ({ sequence }) => {
        calls.push(`low:${sequence}`)
      },
      { priority: 1 },
    )

    manager.onRawInput(
      ({ sequence }) => {
        calls.push(`high:first:${sequence}`)
      },
      { priority: 10 },
    )

    manager.onRawInput(
      ({ sequence }) => {
        calls.push(`high:second:${sequence}`)
      },
      { priority: 10 },
    )

    renderer.stdin.emit("data", Buffer.from("x"))

    expect(calls).toEqual(["high:first:x", "high:second:x", "low:x"])

    offLow()
    calls.length = 0

    renderer.stdin.emit("data", Buffer.from("y"))

    expect(calls).toEqual(["high:first:y", "high:second:y"])
  })

  test("prefers higher-priority layers and newer layers within the same scope", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "global-low",
        run() {
          calls.push("global-low")
        },
      },
      {
        name: "global-high",
        run() {
          calls.push("global-high")
        },
      },
      {
        name: "older",
        run() {
          calls.push("older")
        },
      },
      {
        name: "newer",
        run() {
          calls.push("newer")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      priority: 1,
      bindings: [{ key: "x", cmd: "global-low" }],
    })
    manager.registerLayer({
      scope: "global",
      priority: 2,
      bindings: [{ key: "x", cmd: "global-high" }],
    })
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "y", cmd: "older" }],
    })
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "y", cmd: "newer" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["global-high", "newer"])
  })

  test("lets commands decline handling so lower layers can continue", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let renderableCount = 0
    let laterGlobalCount = 0

    const target = createFocusableBox("decline-target")
    target.onKeyDown = () => {
      renderableCount += 1
    }
    renderer.root.add(target)

    renderer.keyInput.on("keypress", () => {
      laterGlobalCount += 1
    })

    manager.registerCommands([
      {
        name: "local-decline",
        run() {
          calls.push("local")
          return false
        },
      },
      {
        name: "global-handle",
        run() {
          calls.push("global")
        },
      },
    ])

    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local-decline" }],
    })
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "global-handle" }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["local", "global"])
    expect(renderableCount).toBe(0)
    expect(laterGlobalCount).toBe(0)
  })

  test("consumes async command bindings immediately", async () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let laterGlobalCount = 0
    let renderableCount = 0

    const target = createFocusableBox("async-target")
    target.onKeyDown = () => {
      renderableCount += 1
    }
    renderer.root.add(target)

    renderer.keyInput.on("keypress", () => {
      laterGlobalCount += 1
    })

    manager.registerCommands([
      {
        name: "async-command",
        async run() {
          await Bun.sleep(0)
          calls.push("async")
        },
      },
    ])

    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "async-command" }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(renderableCount).toBe(0)
    expect(laterGlobalCount).toBe(0)

    await Bun.sleep(0)

    expect(calls).toEqual(["async"])
  })

  test("clears pending sequences when a layer is disposed", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([{ name: "delete-line", run() {} }])

    const offLayer = manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")
    expect(manager.getPendingSequence()).toHaveLength(1)

    offLayer()

    expect(manager.getPendingSequence()).toEqual([])
  })

  test("clears pending sequences when layer requirements stop matching", () => {
    const manager = getKeymapManager(renderer)

    manager.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      scope: "global",
      mode: "normal",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    manager.setData("vim.mode", "normal")
    mockInput.pressKey("d")
    expect(manager.getPendingSequence()).toHaveLength(1)

    manager.setData("vim.mode", "visual")

    expect(manager.getPendingSequence()).toEqual([])
  })

  test("can unsubscribe pending sequence listeners", () => {
    const manager = getKeymapManager(renderer)
    const changes: string[] = []

    manager.registerCommands([{ name: "delete-ca", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    const off = manager.onPendingSequenceChange((sequence) => {
      changes.push(sequence.map((stroke) => stroke.name).join(""))
    })

    mockInput.pressKey("d")
    off()
    mockInput.pressKey("c")
    manager.clearPendingSequence()

    expect(changes).toEqual(["d"])
  })

  test("uses a stable pending sequence listener snapshot when listeners unsubscribe mid-notification", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([{ name: "delete-ca", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    let offSecond!: () => void

    manager.onPendingSequenceChange((sequence) => {
      calls.push(`first:${sequence.map((stroke) => stroke.name).join("")}`)
      offSecond()
    })

    offSecond = manager.onPendingSequenceChange((sequence) => {
      calls.push(`second:${sequence.map((stroke) => stroke.name).join("")}`)
    })

    mockInput.pressKey("d")
    manager.clearPendingSequence()

    expect(calls).toEqual(["first:d", "second:d", "first:"])
  })

  test("recompiles tokenized layers when tokens are registered and disposed", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "leader-action",
        run() {
          calls.push("leader")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    expect(getActiveKeyNames(manager)).toEqual(["a"])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader"])

    const offToken = manager.registerToken({
      token: "<leader>",
      key: { name: "x", ctrl: true },
    })

    expect(getActiveKeyNames(manager)).toEqual(["x"])
    expect(getActiveKeyDisplay(manager, "<leader>")?.commands.map((command) => command.input)).toEqual([
      "leader-action",
    ])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader"])

    mockInput.pressKey("x", { ctrl: true })
    expect(stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true })).toBe("<leader>")
    expect(getActiveKeyNames(manager)).toEqual(["a"])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader", "leader"])

    offToken()

    expect(getActiveKeyNames(manager)).toEqual(["a"])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader", "leader", "leader"])
  })

  test("keeps token-only bindings inactive until the token is registered", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "leader-only",
        run() {
          calls.push("leader-only")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>", cmd: "leader-only" }],
    })

    expect(manager.getActiveKeys()).toEqual([])

    manager.registerToken({
      token: "<leader>",
      key: { name: "x", ctrl: true },
    })

    expect(getActiveKeyDisplay(manager, "<leader>")?.commands.map((command) => command.input)).toEqual(["leader-only"])

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["leader-only"])
  })

  test("clears pending tokenized sequences when token registration recompiles their layer", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([{ name: "leader-action", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>ab", cmd: "leader-action" }],
    })

    mockInput.pressKey("a")

    expect(manager.getPendingSequence()).toEqual([{ name: "a", ctrl: false, shift: false, meta: false, super: false }])

    manager.registerToken({
      token: "<leader>",
      key: { name: "x", ctrl: true },
    })

    expect(manager.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(manager)).toEqual(["x"])
  })

  test("keeps token registration transactional when recompilation would create a prefix conflict", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([
      { name: "plain", run() {} },
      { name: "tokenized", run() {} },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "a", cmd: "plain" },
        { key: "<leader>b", cmd: "tokenized" },
      ],
    })

    expect(getActiveKeyNames(manager)).toEqual(["a", "b"])

    expect(() => {
      manager.registerToken({
        token: "<leader>",
        key: "a",
      })
    }).toThrow("Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer")

    expect(getActiveKeyNames(manager)).toEqual(["a", "b"])
  })

  test("can dispose layer, binding, and command field registrations", () => {
    const manager = getKeymapManager(renderer)

    const offLayerFields = manager.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    offLayerFields()

    expect(() => {
      manager.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).toThrow('Unknown keymap layer field "mode"')

    const offBindingFields = manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    offBindingFields()

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", mode: "normal", cmd: "noop" }] as any,
      })
    }).toThrow('Unknown keymap binding field "mode"')

    const offCommandFields = manager.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
    })
    offCommandFields()

    expect(() => {
      manager.registerCommands([
        {
          name: "noop",
          desc: "No operation",
          run() {},
        },
      ])
    }).toThrow('Unknown keymap command field "desc"')
  })

  test("merges active bindings across layers while preserving metadata", () => {
    const manager = getKeymapManager(renderer)

    manager.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
    })
    manager.registerCommandFields({
      category(value, ctx) {
        ctx.attr("category", value)
      },
    })

    manager.registerCommands([
      { name: "save", category: "File", run() {} },
      { name: "help", category: "Help", run() {} },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save", desc: "Save file" }],
    })
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "help", desc: "Show help" }],
    })

    const activeKey = getActiveKey(manager, "x", { includeBindings: true })

    expect(activeKey?.bindings?.map((binding) => binding.attrs?.["desc"]).sort()).toEqual(["Save file", "Show help"])
    expect(activeKey?.commands.map((command) => command.attrs?.["category"]).sort()).toEqual(["File", "Help"])
  })

  test("merges active keys across layers and falls back to canonical display when labels conflict", () => {
    const manager = getKeymapManager(renderer)

    manager.registerToken({
      token: "<leader>",
      key: { name: "x", ctrl: true },
    })

    manager.registerCommands([
      { name: "plain", run() {} },
      { name: "leader", run() {} },
    ])

    manager.registerLayer({
      scope: "global",
      priority: 1,
      bindings: [{ key: "ctrl+x", cmd: "plain" }],
    })
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader" }],
    })

    const activeKey = manager
      .getActiveKeys()
      .find((candidate) => candidate.stroke.name === "x" && candidate.stroke.ctrl)

    expect(activeKey?.commands.map((command) => command.input).sort()).toEqual(["leader", "plain"])
    expect(activeKey?.continues).toBe(true)
    expect(activeKey?.display).toBe("ctrl+x")
  })

  test("validates command names and command inputs", () => {
    const manager = getKeymapManager(renderer)

    expect(() => {
      manager.registerCommands([{ name: "", run() {} }])
    }).toThrow("Invalid keymap command name: name cannot be empty")

    expect(() => {
      manager.registerCommands([{ name: "bad name", run() {} }])
    }).toThrow('Invalid keymap command name "bad name": command names cannot contain whitespace')

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", cmd: "   " }],
      })
    }).toThrow("Invalid keymap command: command cannot be empty")
  })

  test("parses special and modifier keys and rejects invalid key sequences", () => {
    const manager = getKeymapManager(renderer)
    const leaderToken = new Map([["<leader>", { name: "x", ctrl: true, shift: false, meta: false, super: false }]])

    expect(parseKeySequenceLike("+")).toEqual([
      {
        stroke: { name: "+", ctrl: false, shift: false, meta: false, super: false },
        display: "+",
      },
    ])
    expect(parseKeySequenceLike(" ")).toEqual([
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
      },
    ])
    expect(parseKeySequenceLike({ name: " " })).toEqual([
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
      },
    ])
    expect(parseKeySequenceLike("ctrl+shift+alt+super+x")).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: true, meta: true, super: true },
        display: "ctrl+shift+meta+super+x",
      },
    ])
    expect(stringifyKeyStroke(parseKeySequenceLike("meta+super+x")[0]!)).toBe("meta+super+x")
    expect(parseKeySequenceLike("zz")).toEqual([
      {
        stroke: { name: "z", ctrl: false, shift: false, meta: false, super: false },
        display: "z",
      },
      {
        stroke: { name: "z", ctrl: false, shift: false, meta: false, super: false },
        display: "z",
      },
    ])
    expect(parseKeySequenceLike("   ")).toEqual([
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
      },
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
      },
      {
        stroke: { name: "space", ctrl: false, shift: false, meta: false, super: false },
        display: "space",
      },
    ])
    expect(parseKeySequenceLike("<leader>")).toEqual([])
    expect(parseKeySequenceLike("g<leader>d")).toEqual([
      {
        stroke: { name: "g", ctrl: false, shift: false, meta: false, super: false },
        display: "g",
      },
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
      },
    ])
    expect(parseKeySequenceLike("<leader>zz")).toEqual([
      {
        stroke: { name: "z", ctrl: false, shift: false, meta: false, super: false },
        display: "z",
      },
      {
        stroke: { name: "z", ctrl: false, shift: false, meta: false, super: false },
        display: "z",
      },
    ])
    expect(parseKeySequenceLike("<leader>", leaderToken)).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
      },
    ])

    expect(() => parseKeySequenceLike("")).toThrow("Invalid key sequence: sequence cannot be empty")
    expect(() => parseKeySequenceLike("<leader")).toThrow('Invalid key sequence "<leader": unterminated token')
    expect(() => parseKeySequenceLike("ctrl+shift")).toThrow('Invalid key "ctrl+shift": missing key name')
    expect(() => parseKeySequenceLike("ctrl+a+b")).toThrow(
      'Invalid key "ctrl+a+b": multiple key names are not supported',
    )
    expect(() => parseKeySequenceLike({ name: "   " } as any)).toThrow("Invalid key name: key name cannot be empty")

    expect(() => {
      manager.registerToken({ token: "<leader>", key: "dd" })
    }).toThrow('Invalid key "dd": expected a single key stroke')
  })
})
