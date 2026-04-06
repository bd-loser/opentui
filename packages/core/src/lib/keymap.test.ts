import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../renderables/Box.js"
import { InputRenderable, InputRenderableEvents } from "../renderables/Input.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../testing.js"
import {
  compileEditBufferKeyBindings,
  registerActionCommands,
  registerEditBufferCommands,
  registerExCommands,
  useKeymap,
  useKeymappings,
} from "./keymap.js"

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
    const first = useKeymappings(renderer)
    const second = useKeymappings(renderer)

    expect(first).toBe(second)
  })

  test("creates a fresh manager after manual destroy", () => {
    const first = useKeymappings(renderer)
    first.destroy()

    const second = useKeymappings(renderer)
    expect(second).not.toBe(first)
  })

  test("matches a target layer by default with focus-within semantics", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []

    const parent = createFocusableBox("parent")
    const child = createFocusableBox("child")
    parent.add(child)
    renderer.root.add(parent)

    registerActionCommands(manager, [
      {
        name: "parent-action",
        run() {
          calls.push("parent")
        },
      },
    ])

    useKeymap(manager, {
      target: parent,
      bindings: [{ key: "x", cmd: "parent-action" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["parent"])
  })

  test("does not match focus-only layers for focused descendants", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []

    const parent = createFocusableBox("focus-parent")
    const child = createFocusableBox("focus-child")
    parent.add(child)
    renderer.root.add(parent)

    registerActionCommands(manager, [
      {
        name: "focus-only",
        run() {
          calls.push("focus-only")
        },
      },
    ])

    useKeymap(manager, {
      target: parent,
      scope: "focus",
      bindings: [{ key: "x", cmd: "focus-only" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })

  test("prefers local layers over global ones and supports fallthrough", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []

    const target = createFocusableBox("target")
    renderer.root.add(target)

    registerActionCommands(manager, [
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

    useKeymap(manager, {
      scope: "global",
      bindings: [
        { key: "x", cmd: "global-action" },
        { key: "y", cmd: "global-action" },
      ],
    })

    useKeymap(manager, {
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
    const manager = useKeymappings(renderer)
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

    registerActionCommands(manager, [
      {
        name: "consume",
        run() {
          calls.push("keymap")
        },
      },
    ])

    useKeymap(manager, {
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
    const manager = useKeymappings(renderer)
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

    registerActionCommands(manager, [
      {
        name: "passthrough",
        run() {
          calls.push("keymap")
        },
      },
    ])

    useKeymap(manager, {
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
    const manager = useKeymappings(renderer)
    const calls: string[] = []
    let enabled = false

    registerActionCommands(manager, [
      {
        name: "layer-command",
        run() {
          calls.push("layer")
        },
      },
    ])

    useKeymap(manager, {
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
    const manager = useKeymappings(renderer)
    const calls: string[] = []

    registerActionCommands(manager, [
      {
        name: "shorthand",
        run() {
          calls.push("shorthand")
        },
      },
    ])

    useKeymap(manager, {
      scope: "global",
      bindings: {
        x: "shorthand",
      },
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["shorthand"])
  })

  test("throws when duplicate command names are registered", () => {
    const manager = useKeymappings(renderer)

    registerActionCommands(manager, [{ name: "dup", run() {} }])

    expect(() => {
      registerActionCommands(manager, [{ name: "dup", run() {} }])
    }).toThrow('Keymap command "dup" is already registered')
  })

  test("supports typed binding fields through extensions", () => {
    const manager = useKeymappings(renderer)
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

    registerActionCommands(manager, [
      {
        name: "typed-field",
        run() {
          calls.push("field")
        },
      },
    ])

    useKeymap(manager, {
      scope: "global",
      bindings: [{ key: "x", mode: "normal", cmd: "typed-field" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["field"])
  })

  test("supports token prefixes and typed fields together", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []

    manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    manager.registerToken({
      token: "<normal>",
      data: { "vim.mode": "normal" },
    })

    manager.onKeyInput(({ event, setData }) => {
      if (event.name === "x") {
        setData("vim.mode", "normal")
      }
    })

    registerActionCommands(manager, [
      {
        name: "record",
        run() {
          calls.push("token")
        },
      },
    ])

    useKeymap(manager, {
      scope: "global",
      bindings: [
        { key: "<normal>x", cmd: "record", fallthrough: true },
        { key: "x", mode: "normal", cmd: "record", fallthrough: true },
      ],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["token", "token"])
  })

  test("throws on conflicting requirements from tokens and typed fields", () => {
    const manager = useKeymappings(renderer)

    manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    manager.registerToken({
      token: "<normal>",
      data: { "vim.mode": "normal" },
    })

    expect(() => {
      useKeymap(manager, {
        scope: "global",
        bindings: [{ key: "<normal>x", mode: "visual", cmd: "noop" }],
      })
    }).toThrow('Conflicting keymap requirement for "vim.mode"')
  })

  test("throws on unknown binding fields", () => {
    const manager = useKeymappings(renderer)

    expect(() => {
      useKeymap(manager, {
        scope: "global",
        bindings: [{ key: "x", mode: "normal", cmd: "noop" }],
      })
    }).toThrow('Unknown keymap binding field "mode"')
  })

  test("supports leader extensions built with tokens and key hooks", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []
    let leaderArmed = false

    registerActionCommands(manager, [
      {
        name: "leader-action",
        run() {
          calls.push("leader")
        },
      },
    ])

    manager.registerToken({
      token: "<leader>",
      data: { prefix: "leader" },
    })

    manager.onKeyInput(({ event, consume, setData }) => {
      if (!leaderArmed) {
        if (event.ctrl && event.name === "x") {
          leaderArmed = true
          consume()
        }
        return
      }

      leaderArmed = false
      setData("prefix", "leader")
    })

    useKeymap(manager, {
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("supports ex commands, aliases, and nargs validation", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []

    registerActionCommands(manager, [
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

    useKeymap(manager, {
      scope: "global",
      bindings: [
        { key: "x", cmd: "fallback" },
        { key: "y", cmd: ":w file.txt" },
      ],
    })

    useKeymap(manager, {
      target,
      bindings: [{ key: "x", cmd: ":write" }],
    })

    target.focus()
    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["fallback", "write:file.txt"])
  })

  test("supports raw input hooks and stop semantics", () => {
    const manager = useKeymappings(renderer)
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

    const manager = useKeymappings(renderer)
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
    const manager = useKeymappings(renderer)
    const calls: string[] = []

    registerActionCommands(manager, [
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

    useKeymap(manager, {
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    useKeymap(manager, {
      scope: "global",
      bindings: [{ key: "x", cmd: "global" }],
    })

    target.destroy()
    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
  })

  test("passes target, args, and runtime data to commands", () => {
    const manager = useKeymappings(renderer)
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

    registerActionCommands(manager, [
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

    useKeymap(manager, {
      target: parent,
      bindings: [{ key: "x", mode: "normal", cmd: "record one two" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(seen).toEqual([{ target: "ctx-parent", args: "one,two", mode: "normal" }])
  })

  test("registerEditBufferCommands can drive textarea actions", () => {
    const manager = useKeymappings(renderer)
    registerEditBufferCommands(manager)

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    useKeymap(manager, {
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    textarea.focus()
    textarea.gotoLine(1)
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")
  })

  test("registerEditBufferCommands supports submit on input renderables", () => {
    const manager = useKeymappings(renderer)
    registerEditBufferCommands(manager)

    let submitted = 0
    const input = new InputRenderable(renderer, {
      width: 20,
      value: "Hello",
    })
    input.on(InputRenderableEvents.ENTER, () => {
      submitted += 1
    })
    renderer.root.add(input)

    useKeymap(manager, {
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    input.focus()
    mockInput.pressKey("x")

    expect(submitted).toBe(1)
    expect(input.value).toBe("Hello")
  })

  test("compileEditBufferKeyBindings normalizes simple config", () => {
    const bindings = compileEditBufferKeyBindings([
      { key: "ctrl+d", cmd: "delete-line" },
      { key: "enter", cmd: "submit" },
      { key: { name: "left", shift: true }, cmd: "select-left" },
    ])

    expect(bindings).toEqual([
      { name: "d", ctrl: true, shift: undefined, meta: undefined, super: undefined, action: "delete-line" },
      { name: "return", ctrl: undefined, shift: undefined, meta: undefined, super: undefined, action: "submit" },
      { name: "left", ctrl: undefined, shift: true, meta: undefined, super: undefined, action: "select-left" },
    ])
  })

  test("compileEditBufferKeyBindings supports object shorthand", () => {
    const bindings = compileEditBufferKeyBindings({
      "ctrl+d": "delete-line",
      enter: "submit",
    })

    expect(bindings).toEqual([
      { name: "d", ctrl: true, shift: undefined, meta: undefined, super: undefined, action: "delete-line" },
      { name: "return", ctrl: undefined, shift: undefined, meta: undefined, super: undefined, action: "submit" },
    ])
  })

  test("compileEditBufferKeyBindings rejects unsupported config", () => {
    expect(() => compileEditBufferKeyBindings([{ key: "<leader>x", cmd: "delete-line" }])).toThrow(
      'Unknown keymap token "<leader>"',
    )

    expect(() => compileEditBufferKeyBindings([{ key: "x", mode: "normal", cmd: "delete-line" }])).toThrow(
      'Edit-buffer key bindings do not support the extra field "mode"',
    )

    expect(() => compileEditBufferKeyBindings([{ key: "x", cmd: "delete-line now" }])).toThrow(
      'Edit-buffer command "delete-line now" cannot include arguments',
    )

    expect(() => compileEditBufferKeyBindings([{ key: "x", cmd: "missing-command" }])).toThrow(
      'Unknown edit-buffer command "missing-command"',
    )
  })
})
