import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable, InputRenderable, InputRenderableEvents, TextareaRenderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import {
  createTextareaBindings,
  registerEditBufferCommands,
  registerManagedTextareaLayer,
  registerTextareaMappingSuspension,
} from "@opentui/keymap/addons/opentui"
import { registerMetadataFields } from "@opentui/keymap/addons"
import { getKeymap } from "@opentui/keymap/opentui"

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
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    expect(keymap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      false,
    )

    registerEditBufferCommands(renderer)

    expect(keymap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
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
    const keymap = getKeymap(renderer)

    registerEditBufferCommands(renderer)
    keymap.registerLayer({
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
    const keymap = getKeymap(renderer)

    registerEditBufferCommands(renderer)
    keymap.registerLayer({
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

  test("registerManagedTextareaLayer normalizes shorthand overrides through keymap.normalizeBindings", () => {
    const keymap = getKeymap(renderer)
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2",
    })
    renderer.root.add(textarea)

    registerEditBufferCommands(renderer)
    const off = registerManagedTextareaLayer(renderer, {
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
    const keymap = getKeymap(renderer)
    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "abc",
    })
    renderer.root.add(textarea)

    const offSuspension = registerTextareaMappingSuspension(renderer)

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
    const keymap = getKeymap(renderer)
    let submitted = 0

    const input = new InputRenderable(renderer, {
      width: 20,
      value: "Hello",
    })
    input.on(InputRenderableEvents.ENTER, () => {
      submitted += 1
    })
    renderer.root.add(input)

    const offSuspension = registerTextareaMappingSuspension(renderer)

    input.focus()
    expect(input.traits.suspend).toBeUndefined()

    mockInput.pressEnter()
    expect(submitted).toBe(1)

    offSuspension()
  })

  test("does not double-run textarea actions when a global binding uses the same stroke", () => {
    const keymap = getKeymap(renderer)

    registerEditBufferCommands(renderer)
    keymap.registerLayer({
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
    const keymap = getKeymap(renderer)
    let submitted = 0

    registerEditBufferCommands(renderer)
    keymap.registerLayer({
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
    const keymap = getKeymap(renderer)
    let submitted = 0

    const offFirst = registerEditBufferCommands(renderer)
    const offSecond = registerEditBufferCommands(renderer)
    keymap.registerLayer({
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
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
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
    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "fallback" }],
    })

    registerEditBufferCommands(renderer)
    keymap.registerLayer({
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
    const keymap = getKeymap(renderer)

    const off = registerManagedTextareaLayer(renderer, {
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
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
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

    const off = registerManagedTextareaLayer(renderer, {
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
    const keymap = getKeymap(renderer)

    registerMetadataFields(keymap)
    registerEditBufferCommands(renderer, {
      descriptions: {
        "delete-line": "Supprimer la ligne",
      },
    })

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "delete-line" }],
    })

    const activeKey = keymap.getActiveKeys({ includeMetadata: true }).find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.commandAttrs).toEqual({ desc: "Supprimer la ligne" })
  })

  test("registerManagedTextareaLayer applies custom descriptions to generated default bindings", () => {
    const keymap = getKeymap(renderer)

    registerMetadataFields(keymap)
    const off = registerManagedTextareaLayer(
      renderer,
      {
        scope: "global",
      },
      {
        descriptions: {
          "move-left": "Curseur gauche",
        },
      },
    )

    const activeKey = keymap
      .getActiveKeys({ includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "left")

    expect(activeKey?.bindingAttrs).toEqual({ desc: "Curseur gauche" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Curseur gauche" })

    off()
  })

  test("shared edit buffer command registrations ignore later description overrides", () => {
    const keymap = getKeymap(renderer)

    registerEditBufferCommands(renderer, {
      descriptions: {
        "move-left": "Cursor left",
      },
    })

    expect(() => {
      registerEditBufferCommands(renderer, {
        descriptions: {
          "move-left": "Curseur gauche",
        },
      })
    }).not.toThrow()
  })

  test("disposes single registrations cleanly and supports re-registration", () => {
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    const off = registerEditBufferCommands(renderer)

    expect(keymap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      true,
    )

    off()
    off()

    expect(keymap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      false,
    )

    registerEditBufferCommands(renderer)

    expect(keymap.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
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
    const keymap = getKeymap(renderer)

    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    const offFirst = registerEditBufferCommands(renderer)
    const offSecond = registerEditBufferCommands(renderer)

    textarea.focus()
    textarea.gotoLine(1)

    offSecond()
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")

    offFirst()
    offSecond()
  })

  test("allows colliding command names on separate layers and continues registering the rest of the batch", () => {
    const keymap = getKeymap(renderer)
    const errors: string[] = []

    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "delete-line",
          run() {},
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    expect(() => {
      registerEditBufferCommands(renderer)
    }).not.toThrow()

    expect(errors).toEqual([])
    expect(keymap.getCommands().some((command) => command.name === "submit")).toBe(true)
    expect(
      keymap.getCommands({ visibility: "registered" }).filter((command) => command.name === "delete-line"),
    ).toHaveLength(2)
    expect(keymap.getActiveKeys().find((candidate) => candidate.stroke.name === "x")?.command).toBe("submit")
  })
})
