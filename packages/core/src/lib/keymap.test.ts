import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../testing.js"
import { registerActionCommands, registerExCommands, useKeymap, useKeymappings } from "./keymap.js"

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
      bindings: {
        x: "parent-action",
      },
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
      bindings: {
        x: "focus-only",
      },
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
      bindings: {
        x: "global-action",
        y: "global-action",
      },
    })

    useKeymap(manager, {
      target,
      bindings: {
        x: "local-action",
        y: {
          command: "fallthrough-action",
          fallthrough: true,
        },
      },
    })

    target.focus()

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["local", "fallthrough-local", "global"])
  })

  test("stops later global listeners and focused renderables by default", () => {
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
      bindings: {
        x: "consume",
      },
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["keymap"])
    expect(laterGlobalCount).toBe(0)
    expect(renderableCount).toBe(0)
  })

  test("can opt out of preventDefault and stopPropagation", () => {
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

    useKeymap(manager, {
      target,
      bindings: {
        x: {
          command: () => {
            calls.push("keymap")
          },
          preventDefault: false,
          stopPropagation: false,
        },
      },
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["keymap"])
    expect(laterGlobalCount).toBe(1)
    expect(renderableCount).toBe(1)
  })

  test("supports binding enabled predicates", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []
    let enabled = false

    const target = createFocusableBox("enabled-target")
    renderer.root.add(target)

    useKeymap(manager, {
      target,
      bindings: {
        x: {
          command: () => {
            calls.push("enabled")
          },
          enabled: () => enabled,
        },
      },
    })

    target.focus()
    mockInput.pressKey("x")
    enabled = true
    mockInput.pressKey("x")

    expect(calls).toEqual(["enabled"])
  })

  test("supports layer enabled predicates", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []
    let enabled = false

    useKeymap(manager, {
      scope: "global",
      enabled: () => enabled,
      bindings: {
        x: () => {
          calls.push("layer")
        },
      },
    })

    mockInput.pressKey("x")
    enabled = true
    mockInput.pressKey("x")

    expect(calls).toEqual(["layer"])
  })

  test("supports custom command kinds", () => {
    const manager = useKeymappings(renderer)
    const values: string[] = []

    manager.registerCommandKind("custom", (value, ctx) => {
      values.push(`${String(value)}:${String(ctx.data.scope)}`)
      return true
    })

    const offToken = manager.registerToken({
      token: "<custom>",
      data: { scope: "custom" },
    })
    const offHook = manager.onKeyInput(({ event, setData }) => {
      if (event.name === "x") {
        setData("scope", "custom")
      }
    })

    useKeymap(manager, {
      scope: "global",
      bindings: {
        "<custom>x": {
          command: { kind: "custom", value: "ran" },
        },
      },
    })

    mockInput.pressKey("x")

    offHook()
    offToken()

    expect(values).toEqual(["ran:custom"])
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
      bindings: {
        x: "fallback",
        y: ":w file.txt",
      },
    })

    useKeymap(manager, {
      target,
      bindings: {
        x: ":write",
      },
    })

    target.focus()
    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["fallback", "write:file.txt"])
  })

  test("supports token-based leader extensions built with key hooks", () => {
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
      bindings: {
        "<leader>a": "leader-action",
      },
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("a")

    expect(calls).toEqual(["leader"])
  })

  test("allows bindings to start matching after their token is registered", () => {
    const manager = useKeymappings(renderer)
    const calls: string[] = []

    registerActionCommands(manager, [
      {
        name: "token-action",
        run() {
          calls.push("token")
        },
      },
    ])

    useKeymap(manager, {
      scope: "global",
      bindings: {
        "<late>a": "token-action",
      },
    })

    mockInput.pressKey("a")

    manager.registerToken({
      token: "<late>",
      data: { prefix: "late" },
    })
    manager.onKeyInput(({ event, setData }) => {
      if (event.name === "a") {
        setData("prefix", "late")
      }
    })

    mockInput.pressKey("a")

    expect(calls).toEqual(["token"])
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
      bindings: {
        x: "local",
      },
    })

    useKeymap(manager, {
      scope: "global",
      bindings: {
        x: "global",
      },
    })

    target.destroy()
    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
  })

  test("passes the active layer target to command contexts", () => {
    const manager = useKeymappings(renderer)
    const seenTargets: string[] = []

    const parent = createFocusableBox("ctx-parent")
    const child = createFocusableBox("ctx-child")
    parent.add(child)
    renderer.root.add(parent)

    registerActionCommands(manager, [
      {
        name: "record-target",
        run(ctx) {
          if (ctx.target) {
            seenTargets.push(ctx.target.id)
          }
        },
      },
    ])

    useKeymap(manager, {
      target: parent,
      bindings: {
        x: "record-target",
      },
    })

    child.focus()
    mockInput.pressKey("x")

    expect(seenTargets).toEqual(["ctx-parent"])
  })

  test("passes event metadata to command contexts", () => {
    const manager = useKeymappings(renderer)
    const seenScopes: string[] = []

    registerActionCommands(manager, [
      {
        name: "record-scope",
        run(ctx) {
          seenScopes.push(String(ctx.data.scope))
        },
      },
    ])

    manager.onKeyInput(({ event, setData }) => {
      if (event.name === "x") {
        setData("scope", "global")
      }
    })

    useKeymap(manager, {
      scope: "global",
      bindings: {
        x: "record-scope",
      },
    })

    mockInput.pressKey("x")

    expect(seenScopes).toEqual(["global"])
  })
})
