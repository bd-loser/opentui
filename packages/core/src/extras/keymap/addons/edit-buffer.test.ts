import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { InputRenderable, InputRenderableEvents } from "../../../renderables/Input.js"
import { TextareaRenderable } from "../../../renderables/Textarea.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { compileEditBufferKeyBindings, registerEditBufferCommands, registerEditBufferKeymap } from "./edit-buffer.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("edit buffer addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("registerEditBufferCommands can drive textarea actions", () => {
    const manager = getKeymapManager(renderer)
    registerEditBufferCommands(manager)

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    textarea.focus()
    textarea.gotoLine(1)
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")
  })

  test("registerEditBufferCommands supports submit on input renderables", () => {
    const manager = getKeymapManager(renderer)
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

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    input.focus()
    mockInput.pressKey("x")

    expect(submitted).toBe(1)
    expect(input.value).toBe("Hello")
  })

  test("registerEditBufferCommands is idempotent for the same manager", () => {
    const manager = getKeymapManager(renderer)
    const offFirst = registerEditBufferCommands(manager)
    const offSecond = registerEditBufferCommands(manager)

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    textarea.focus()
    textarea.gotoLine(1)
    offFirst()
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")

    offSecond()
  })

  test("registerEditBufferKeymap supports sequence bindings", () => {
    const manager = getKeymapManager(renderer)

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    textarea.focus()
    textarea.gotoLine(1)
    mockInput.pressKey("d")
    mockInput.pressKey("d")

    expect(textarea.plainText).toBe("Line 1\nLine 3")
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

    expect(() => compileEditBufferKeyBindings([{ key: "dd", cmd: "delete-line" }])).toThrow(
      "Edit-buffer key bindings only support a single key stroke",
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
