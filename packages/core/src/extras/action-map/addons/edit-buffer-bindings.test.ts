import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../../../renderables/Box.js"
import { InputRenderable, InputRenderableEvents } from "../../../renderables/Input.js"
import { TextareaRenderable } from "../../../renderables/Textarea.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getActionMap } from "../index.js"
import {
  createTextareaBindings,
  registerEditBufferCommands,
  registerManagedTextareaLayer,
  registerTextareaMappingSuspension,
} from "./edit-buffer-bindings.js"
import { registerMetadataFields } from "./metadata.js"

let renderer: TestRenderer
let mockInput: MockInput

describe("edit buffer bindings addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("registerEditBufferCommands resolves plain layers that were registered first", () => {
    const manager = getActionMap(renderer)

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
    const manager = getActionMap(renderer)

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
    const manager = getActionMap(renderer)

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

  test("createTextareaBindings prepends override-style bindings ahead of textarea defaults", () => {
    const bindings = createTextareaBindings([
      { key: "left", cmd: "custom-left" },
      { key: "dd", cmd: "delete-line" },
    ])

    expect(bindings[0]).toEqual({ key: "left", cmd: "custom-left" })
    expect(bindings[1]).toEqual({ key: "dd", cmd: "delete-line" })
    expect(bindings.some((binding) => binding.key === "right" && binding.cmd === "move-right")).toBe(true)
    expect(bindings.some((binding) => binding.key === "left" && binding.cmd === "move-left")).toBe(true)
    expect(bindings.some((binding) => binding.key === "backspace" && binding.desc === "Delete backward")).toBe(true)
  })

  test("registerTextareaMappingSuspension disables local textarea shortcuts but preserves plain typing", () => {
    const manager = getActionMap(renderer)
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "abc",
    })
    renderer.root.add(textarea)

    const offSuspension = registerTextareaMappingSuspension(manager)

    textarea.focus()
    textarea.cursorOffset = 3
    expect(textarea.traits.suspend).toBe(true)

    mockInput.pressBackspace()
    expect(textarea.plainText).toBe("abc")

    mockInput.pressKey("x")
    expect(textarea.plainText).toBe("abcx")

    offSuspension()
    expect(textarea.traits.suspend).toBeUndefined()

    mockInput.pressBackspace()
    expect(textarea.plainText).toBe("abc")
  })

  test("registerTextareaMappingSuspension leaves input renderables using their own mappings", () => {
    const manager = getActionMap(renderer)
    let submitted = 0

    const input = new InputRenderable(renderer, {
      width: 20,
      value: "Hello",
    })
    input.on(InputRenderableEvents.ENTER, () => {
      submitted += 1
    })
    renderer.root.add(input)

    const offSuspension = registerTextareaMappingSuspension(manager)

    input.focus()
    expect(input.traits.suspend).toBeUndefined()

    mockInput.pressEnter()
    expect(submitted).toBe(1)

    offSuspension()
  })

  test("does not double-run textarea actions when a global binding uses the same stroke", () => {
    const manager = getActionMap(renderer)

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
    const manager = getActionMap(renderer)
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
    const manager = getActionMap(renderer)
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
    const manager = getActionMap(renderer)
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

  test("registerManagedTextareaLayer combines commands, suspension, defaults, and overrides", () => {
    const manager = getActionMap(renderer)

    const off = registerManagedTextareaLayer(manager, {
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
    expect(textarea.traits.suspend).toBe(true)

    mockInput.pressKey("d")
    mockInput.pressKey("d")

    expect(textarea.plainText).toBe("Line 1\nLine 3")

    mockInput.pressKey("x")
    expect(textarea.plainText).toBe("Line 1\nxLine 3")

    off()
    expect(textarea.traits.suspend).toBeUndefined()

    mockInput.pressBackspace()
    expect(textarea.plainText).toBe("Line 1\nLine 3")
  })

  test("registerManagedTextareaLayer lets overrides replace default textarea shortcuts by order", () => {
    const manager = getActionMap(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "custom-left",
        run() {
          calls.push("custom-left")
        },
      },
    ])

    const off = registerManagedTextareaLayer(manager, {
      scope: "global",
      bindings: [{ key: "left", cmd: "custom-left" }],
    })

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "abc",
    })
    renderer.root.add(textarea)

    textarea.focus()
    textarea.cursorOffset = 3

    mockInput.pressArrow("left")

    expect(calls).toEqual(["custom-left"])
    expect(textarea.cursorOffset).toBe(3)

    off()
  })

  test("registerEditBufferCommands applies custom command descriptions when metadata fields are registered", () => {
    const manager = getActionMap(renderer)

    registerMetadataFields(manager)
    registerEditBufferCommands(manager, {
      descriptions: {
        "delete-line": "Supprimer la ligne",
      },
    })

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "delete-line" }],
    })

    const activeKey = manager
      .getActiveKeys({ includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.commandAttrs).toEqual({ desc: "Supprimer la ligne" })
  })

  test("registerManagedTextareaLayer applies custom descriptions to generated default bindings", () => {
    const manager = getActionMap(renderer)

    registerMetadataFields(manager)
    const off = registerManagedTextareaLayer(
      manager,
      {
        scope: "global",
      },
      {
        descriptions: {
          "move-left": "Curseur gauche",
        },
      },
    )

    const activeKey = manager
      .getActiveKeys({ includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "left")

    expect(activeKey?.bindingAttrs).toEqual({ desc: "Curseur gauche" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Curseur gauche" })

    off()
  })

  test("shared edit buffer command registrations ignore later description overrides", () => {
    const manager = getActionMap(renderer)

    registerEditBufferCommands(manager, {
      descriptions: {
        "move-left": "Cursor left",
      },
    })

    expect(() => {
      registerEditBufferCommands(manager, {
        descriptions: {
          "move-left": "Curseur gauche",
        },
      })
    }).not.toThrow()
  })

  test("disposes single registrations cleanly and supports re-registration", () => {
    const manager = getActionMap(renderer)

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
    const manager = getActionMap(renderer)

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

  test("skips colliding commands and continues registering the rest of the batch", () => {
    const manager = getActionMap(renderer)
    const errors: string[] = []

    manager.on("error", (event) => {
      errors.push(event.message)
    })

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
    }).not.toThrow()

    expect(errors).toEqual(['ActionMap command "delete-line" is already registered'])
    expect(manager.getCommands().some((command) => command.name === "submit")).toBe(true)
    expect(manager.getActiveKeys().find((candidate) => candidate.stroke.name === "x")?.command).toBe("submit")
  })
})
