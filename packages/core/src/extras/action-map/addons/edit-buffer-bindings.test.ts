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
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    expect(actionMap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      false,
    )

    registerEditBufferCommands(actionMap)

    expect(actionMap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
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
    const actionMap = getActionMap(renderer)

    registerEditBufferCommands(actionMap)
    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)

    registerEditBufferCommands(actionMap)
    actionMap.registerLayer({
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

  test("registerManagedTextareaLayer normalizes shorthand overrides through actionMap.normalizeBindings", () => {
    const actionMap = getActionMap(renderer)
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2",
    })
    renderer.root.add(textarea)

    registerEditBufferCommands(actionMap)
    const off = registerManagedTextareaLayer(actionMap, {
      target: textarea,
      bindings: { dd: "delete-line" },
    })

    textarea.focus()
    textarea.gotoLine(1)
    mockInput.pressKey("d")
    mockInput.pressKey("d")

    expect(textarea.plainText).toBe("Line 1")

    off()
  })

  test("registerTextareaMappingSuspension disables local textarea shortcuts but preserves plain typing", () => {
    const actionMap = getActionMap(renderer)
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "abc",
    })
    renderer.root.add(textarea)

    const offSuspension = registerTextareaMappingSuspension(actionMap)

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
    const actionMap = getActionMap(renderer)
    let submitted = 0

    const input = new InputRenderable(renderer, {
      width: 20,
      value: "Hello",
    })
    input.on(InputRenderableEvents.ENTER, () => {
      submitted += 1
    })
    renderer.root.add(input)

    const offSuspension = registerTextareaMappingSuspension(actionMap)

    input.focus()
    expect(input.traits.suspend).toBeUndefined()

    mockInput.pressEnter()
    expect(submitted).toBe(1)

    offSuspension()
  })

  test("does not double-run textarea actions when a global binding uses the same stroke", () => {
    const actionMap = getActionMap(renderer)

    registerEditBufferCommands(actionMap)
    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)
    let submitted = 0

    registerEditBufferCommands(actionMap)
    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)
    let submitted = 0

    const offFirst = registerEditBufferCommands(actionMap)
    const offSecond = registerEditBufferCommands(actionMap)
    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "fallback",
          run() {
            calls.push("fallback")
          },
        },
      ],
    })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "fallback" }],
    })

    registerEditBufferCommands(actionMap)
    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)

    const off = registerManagedTextareaLayer(actionMap, {
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
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "custom-left",
          run() {
            calls.push("custom-left")
          },
        },
      ],
    })

    const off = registerManagedTextareaLayer(actionMap, {
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
    const actionMap = getActionMap(renderer)

    registerMetadataFields(actionMap)
    registerEditBufferCommands(actionMap, {
      descriptions: {
        "delete-line": "Supprimer la ligne",
      },
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "delete-line" }],
    })

    const activeKey = actionMap
      .getActiveKeys({ includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.commandAttrs).toEqual({ desc: "Supprimer la ligne" })
  })

  test("registerManagedTextareaLayer applies custom descriptions to generated default bindings", () => {
    const actionMap = getActionMap(renderer)

    registerMetadataFields(actionMap)
    const off = registerManagedTextareaLayer(
      actionMap,
      {
        scope: "global",
      },
      {
        descriptions: {
          "move-left": "Curseur gauche",
        },
      },
    )

    const activeKey = actionMap
      .getActiveKeys({ includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "left")

    expect(activeKey?.bindingAttrs).toEqual({ desc: "Curseur gauche" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Curseur gauche" })

    off()
  })

  test("shared edit buffer command registrations ignore later description overrides", () => {
    const actionMap = getActionMap(renderer)

    registerEditBufferCommands(actionMap, {
      descriptions: {
        "move-left": "Cursor left",
      },
    })

    expect(() => {
      registerEditBufferCommands(actionMap, {
        descriptions: {
          "move-left": "Curseur gauche",
        },
      })
    }).not.toThrow()
  })

  test("disposes single registrations cleanly and supports re-registration", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    const off = registerEditBufferCommands(actionMap)

    expect(actionMap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      true,
    )

    off()
    off()

    expect(actionMap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      false,
    )

    registerEditBufferCommands(actionMap)

    expect(actionMap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
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
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    const offFirst = registerEditBufferCommands(actionMap)
    const offSecond = registerEditBufferCommands(actionMap)

    textarea.focus()
    textarea.gotoLine(1)

    offSecond()
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")

    offFirst()
    offSecond()
  })

  test("allows colliding command names on separate layers and continues registering the rest of the batch", () => {
    const actionMap = getActionMap(renderer)
    const errors: string[] = []

    actionMap.on("error", (event) => {
      errors.push(event.message)
    })

    actionMap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "delete-line",
          run() {},
        },
      ],
    })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    expect(() => {
      registerEditBufferCommands(actionMap)
    }).not.toThrow()

    expect(errors).toEqual([])
    expect(actionMap.getCommands().some((command) => command.name === "submit")).toBe(true)
    expect(
      actionMap.getCommands({ visibility: "registered" }).filter((command) => command.name === "delete-line"),
    ).toHaveLength(2)
    expect(actionMap.getActiveKeys().find((candidate) => candidate.stroke.name === "x")?.command).toBe("submit")
  })
})
