import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../../../renderables/Box.js"
import { InputRenderable, InputRenderableEvents } from "../../../renderables/Input.js"
import { TextareaRenderable } from "../../../renderables/Textarea.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { registerEditBufferKeymap } from "./edit-buffer-keymap.js"

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

  test("registerEditBufferKeymap can drive textarea actions", () => {
    const manager = getKeymapManager(renderer)

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    textarea.focus()
    textarea.gotoLine(1)
    mockInput.pressKey("d", { ctrl: true })

    expect(textarea.plainText).toBe("Line 1\nLine 3")
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

  test("registerEditBufferKeymap supports submit on input renderables", () => {
    const manager = getKeymapManager(renderer)

    let submitted = 0
    const input = new InputRenderable(renderer, {
      width: 20,
      value: "Hello",
    })
    input.on(InputRenderableEvents.ENTER, () => {
      submitted += 1
    })
    renderer.root.add(input)

    registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    input.focus()
    mockInput.pressKey("x")

    expect(submitted).toBe(1)
    expect(input.value).toBe("Hello")
  })

  test("registerEditBufferKeymap keeps shared commands alive across layers", () => {
    const manager = getKeymapManager(renderer)
    const offFirst = registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })
    const offSecond = registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    let submitted = 0
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
    registerEditBufferKeymap(manager, {
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

    const off = registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

    expect(manager.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      true,
    )

    off()
    off()

    expect(manager.getActiveKeys().some((candidate) => candidate.stroke.name === "d" && candidate.stroke.ctrl)).toBe(
      false,
    )

    registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })

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

  test("keeps shared commands registered until the last layer is removed regardless of dispose order", () => {
    const manager = getKeymapManager(renderer)

    const textarea = new TextareaRenderable(renderer, {
      width: 20,
      height: 4,
      initialValue: "Line 1\nLine 2\nLine 3",
    })
    renderer.root.add(textarea)

    const offFirst = registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "ctrl+d", cmd: "delete-line" }],
    })
    const offSecond = registerEditBufferKeymap(manager, {
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    textarea.focus()
    textarea.gotoLine(1)

    offSecond()
    mockInput.pressKey("d", { ctrl: true })
    expect(textarea.plainText).toBe("Line 1\nLine 3")

    offFirst()
    offSecond()
  })

  test("rolls back the layer if command registration fails", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "delete-line",
        run() {
          calls.push("shadow")
        },
      },
    ])

    expect(() => {
      registerEditBufferKeymap(manager, {
        scope: "global",
        bindings: [{ key: "x", cmd: "delete-line" }],
      })
    }).toThrow('Keymap command "delete-line" is already registered')

    expect(calls).toEqual([])
    expect(manager.getActiveKeys().find((candidate) => candidate.stroke.name === "x")).toBeUndefined()
  })
})
