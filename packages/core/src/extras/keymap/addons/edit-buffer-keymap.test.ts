import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../../../renderables/Box.js"
import { InputRenderable, InputRenderableEvents } from "../../../renderables/Input.js"
import { TextareaRenderable } from "../../../renderables/Textarea.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { registerEditBufferCommands } from "./edit-buffer-keymap.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("edit buffer keymap addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("registerEditBufferCommands resolves plain layers that were registered first", () => {
    const manager = getKeymapManager(renderer)

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    expect(manager.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      false,
    )

    registerEditBufferCommands(manager)

    expect(manager.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      true,
    )

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    textarea.focus()
    textarea.gotoLine(1)
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")
  })

  test("supports sequence bindings through plain layers", () => {
    const manager = getKeymapManager(renderer)

    registerEditBufferCommands(manager)
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    textarea.focus()
    textarea.gotoLine(1)
    mockInput.pressKey("d")
    mockInput.pressKey("d")

    expect(textarea.plainText).toBe("Line 1\nLine 3")
  })

  test("passes uncaptured input through to the focused textarea", () => {
    const manager = getKeymapManager(renderer)

    registerEditBufferCommands(manager)
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "left", cmd: "move-left" }],
    })

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "",
    })
    renderer.root.add(textarea)

    textarea.focus()
    mockInput.pressKey("x")

    expect(textarea.plainText).toBe("x")
  })

  test("does not double-run textarea actions when a global binding uses the same stroke", () => {
    const manager = getKeymapManager(renderer)

    registerEditBufferCommands(manager)
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "backspace", cmd: "backspace" }],
    })

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "abc",
    })
    renderer.root.add(textarea)

    textarea.focus()
    textarea.cursorOffset = 3
    mockInput.pressBackspace()

    expect(textarea.plainText).toBe("ab")
    expect(textarea.cursorOffset).toBe(2)
  })

  test("supports submit on input renderables through plain layers", () => {
    const manager = getKeymapManager(renderer)
    let submitted = 0

    registerEditBufferCommands(manager)
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    const input = new InputRenderable(renderer, {
      width: 20,
      value: "Hello",
    })
    input.on(InputRenderableEvents.ENTER, () => {
      submitted += 1
    })
    renderer.root.add(input)

    input.focus()
    mockInput.pressKey("x")

    expect(submitted).toBe(1)
    expect(input.value).toBe("Hello")
  })

  test("keeps shared commands alive across registrations", () => {
    const manager = getKeymapManager(renderer)
    let submitted = 0

    const offFirst = registerEditBufferCommands(manager)
    const offSecond = registerEditBufferCommands(manager)
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    const input = new InputRenderable(renderer, {
      width: 20,
      value: "Hello",
    })
    input.on(InputRenderableEvents.ENTER, () => {
      submitted += 1
    })
    renderer.root.add(input)

    offFirst()
    input.focus()
    mockInput.pressKey("x")

    expect(submitted).toBe(1)

    offSecond()
  })

  test("falls through when there is no focused editor or submit is unsupported", () => {
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
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "fallback" }],
    })

    registerEditBufferCommands(manager)
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    const box = new BoxRenderable(renderer, {
      id: "plain-box",
      width: 10,
      height: 4,
      focusable: true,
    })
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Hello",
    })
    renderer.root.add(box)
    renderer.root.add(textarea)

    box.focus()
    mockInput.pressKey("x")

    textarea.focus()
    ;(textarea as { submit?: unknown }).submit = undefined
    mockInput.pressKey("x")

    expect(calls).toEqual(["fallback", "fallback"])
    expect(textarea.plainText).toBe("Hello")
  })

  test("disposes single registrations cleanly and supports re-registration", () => {
    const manager = getKeymapManager(renderer)

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    const off = registerEditBufferCommands(manager)

    expect(manager.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      true,
    )

    off()
    off()

    expect(manager.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      false,
    )

    registerEditBufferCommands(manager)

    expect(manager.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      true,
    )

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    textarea.focus()
    textarea.gotoLine(1)
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")
  })

  test("keeps shared commands registered until the last registration is removed regardless of dispose order", () => {
    const manager = getKeymapManager(renderer)

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    const offFirst = registerEditBufferCommands(manager)
    const offSecond = registerEditBufferCommands(manager)

    textarea.focus()
    textarea.gotoLine(1)

    offSecond()
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")

    offFirst()
    offSecond()
  })

  test("throws on command name collisions without partially registering the batch", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([
      {
        name: "delete-line",
        run() {},
      },
    ])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    expect(() => {
      registerEditBufferCommands(manager)
    }).toThrow('Keymap command "delete-line" is already registered')

    expect(manager.getActiveKeys().find((candidate) => candidate.stroke.name === "x")).toBeUndefined()
  })
})
