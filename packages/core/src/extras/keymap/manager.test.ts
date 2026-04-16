import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { KeyEvent } from "../../lib/KeyHandler.js"
import { BoxRenderable } from "../../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../testing.js"
import {
  defaultBindingParser,
  defaultBindingSyntax,
  getKeymapManager,
  stringifyKeySequence,
  stringifyKeyStroke,
  type KeymapActiveKey,
  type KeymapActiveKeyOptions,
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
  options?: KeymapActiveKeyOptions,
): KeymapActiveKey | undefined {
  return manager.getActiveKeys(options).find((candidate) => candidate.stroke.name === name)
}

function getActiveKeyNames(manager: KeymapManager): string[] {
  return manager
    .getActiveKeys()
    .map((candidate) => candidate.stroke.name)
    .sort()
}

function getCommand(manager: KeymapManager, name: string) {
  return manager.getCommands().find((candidate) => candidate.name === name)
}

function getActiveKeyDisplay(
  manager: KeymapManager,
  display: string,
  options?: KeymapActiveKeyOptions,
): KeymapActiveKey | undefined {
  return manager.getActiveKeys(options).find((candidate) => candidate.display === display)
}

function getMatchKeyForEventName(event: KeyEvent, name: string): string {
  const normalizedName = name === " " ? "space" : name.trim().toLowerCase()
  if (!normalizedName) {
    throw new Error("Expected non-empty key name")
  }

  return `${normalizedName}:${event.ctrl ? 1 : 0}:${event.shift ? 1 : 0}:${event.meta ? 1 : 0}:${event.super ? 1 : 0}:${event.hyper ? 1 : 0}`
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

  test("supports function binding commands", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const handler = () => {
      calls.push("handled")
    }

    manager.registerLayer({
      bindings: [{ key: "x", cmd: handler }],
    })

    expect(getActiveKey(manager, "x")?.command).toBe(handler)
    expect(getActiveKey(manager, "x", { includeBindings: true })?.bindings?.[0]?.command).toBe(handler)

    mockInput.pressKey("x")

    expect(calls).toEqual(["handled"])
  })

  test("runCommand executes a registered command and returns false for unknown commands", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "save-file",
        run() {
          calls.push("save-file")
        },
      },
    ])

    expect(manager.runCommand("save-file")).toEqual({
      ok: true,
      command: {
        name: "save-file",
        fields: {},
      },
    })
    expect(manager.runCommand("missing-command")).toEqual({ ok: false, reason: "not-found" })
    expect(calls).toEqual(["save-file"])
  })

  test("prefers direct stroke matches over registered fallback strokes", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "y")]
    })

    manager.registerCommands([
      {
        name: "fallback",
        run() {
          calls.push("fallback")
        },
      },
      {
        name: "direct",
        run() {
          calls.push("direct")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "y", cmd: "fallback" },
        { key: "x", cmd: "direct" },
      ],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["direct"])
  })

  test("supports pending-sequence dispatch through registered fallback strokes", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "g")]
    })

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
      bindings: [{ key: "ga", cmd: "delete-line" }],
    })

    mockInput.pressKey("x")
    expect(stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true })).toBe("g")

    mockInput.pressKey("a")

    expect(calls).toEqual(["delete-line"])
    expect(manager.getPendingSequenceParts()).toEqual([])
  })

  test("supports custom binding parsers ahead of the default parser", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.prependBindingParser(({ input, index, tokens }) => {
      if (input[index] !== "[") {
        return undefined
      }

      const end = input.indexOf("]", index)
      if (end === -1) {
        throw new Error(`Invalid key sequence "${input}": unterminated token`)
      }

      const tokenName = input
        .slice(index, end + 1)
        .trim()
        .toLowerCase()
      const token = tokens.get(tokenName)
      if (!token) {
        return { parts: [], nextIndex: end + 1, unknownTokens: [tokenName] }
      }

      return {
        parts: [{ stroke: token.stroke, display: tokenName, matchKey: token.matchKey }],
        nextIndex: end + 1,
        usedTokens: [tokenName],
      }
    })

    manager.registerToken({ token: "[leader]", key: { name: "x", ctrl: true } })
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
      bindings: [{ key: "[leader]d", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("d")

    expect(calls).toEqual(["leader"])
  })

  test("clearBindingParsers allows replacing the default parser", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.clearBindingParsers()
    manager.appendBindingParser(({ input, index, tokens }) => {
      if (input[index] !== "[") {
        return undefined
      }

      const end = input.indexOf("]", index)
      if (end === -1) {
        throw new Error(`Invalid key sequence "${input}": unterminated token`)
      }

      const tokenName = input
        .slice(index, end + 1)
        .trim()
        .toLowerCase()
      const token = tokens.get(tokenName)
      if (!token) {
        return { parts: [], nextIndex: end + 1, unknownTokens: [tokenName] }
      }

      return {
        parts: [{ stroke: token.stroke, display: tokenName, matchKey: token.matchKey }],
        nextIndex: end + 1,
        usedTokens: [tokenName],
      }
    })

    manager.registerToken({ token: "[leader]", key: { name: "x", ctrl: true } })
    manager.registerCommands([
      {
        name: "leader-only",
        run() {
          calls.push("leader")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "[leader]", cmd: "leader-only" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["leader"])
  })

  test("clearBindingSyntax disables object keys and token registration until syntax is restored", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.clearBindingSyntax()

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: { name: "x" }, cmd: "object" }],
      })
    }).toThrow("No keymap binding syntax is registered")

    expect(() => {
      manager.registerToken({ token: "<leader>", key: { name: "x", ctrl: true } })
    }).toThrow("No keymap binding syntax is registered")

    manager.setBindingSyntax(defaultBindingSyntax)

    manager.registerCommands([
      {
        name: "object",
        run() {
          calls.push("object")
        },
      },
      {
        name: "token",
        run() {
          calls.push("token")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: { name: "x" }, cmd: "object" }],
    })
    manager.registerToken({ token: "<leader>", key: { name: "x", ctrl: true } })
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>", cmd: "token" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["object", "token"])
  })

  test("supports case-sensitive token names when parser and binding syntax are case-sensitive", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.clearBindingParsers()
    manager.appendBindingParser(({ input, index, tokens }) => {
      if (input[index] !== "[") {
        return undefined
      }

      const end = input.indexOf("]", index)
      if (end === -1) {
        throw new Error(`Invalid key sequence "${input}": unterminated token`)
      }

      const tokenName = input.slice(index, end + 1).trim()
      const token = tokens.get(tokenName)
      if (!token) {
        return { parts: [], nextIndex: end + 1, unknownTokens: [tokenName] }
      }

      return {
        parts: [{ stroke: token.stroke, display: tokenName, matchKey: token.matchKey }],
        nextIndex: end + 1,
        usedTokens: [tokenName],
      }
    })
    manager.appendBindingParser(defaultBindingParser)

    manager.clearBindingSyntax()
    manager.setBindingSyntax({
      normalizeTokenName(token) {
        const normalized = token.trim()
        if (!normalized) {
          throw new Error("Invalid keymap token: token cannot be empty")
        }

        return normalized
      },
      parseObjectKey(key) {
        return defaultBindingSyntax.parseObjectKey(key)
      },
    })

    manager.registerCommands([
      {
        name: "case-token",
        run() {
          calls.push("case-token")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "[Leader]d", cmd: "case-token" }],
    })

    manager.registerToken({ token: "[Leader]", key: { name: "x", ctrl: true } })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("d")

    expect(calls).toEqual(["case-token"])
  })

  test("clearEventMatchResolvers disables default event matching until custom resolvers are added", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "run",
        run() {
          calls.push("run")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "run" }],
    })

    manager.clearEventMatchResolvers()
    mockInput.pressKey("x")
    expect(calls).toEqual([])

    manager.registerEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "x")]
    })

    mockInput.pressKey("x")
    expect(calls).toEqual(["run"])
  })

  test("can dispose registered event match resolvers", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const offResolver = manager.registerEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "y")]
    })

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
      bindings: [{ key: "y", cmd: "fallback" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual(["fallback"])

    offResolver()

    mockInput.pressKey("x")
    expect(calls).toEqual(["fallback"])
  })

  test("matches bindings using parser-provided match keys", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.prependBindingParser(({ input, index }) => {
      if (index !== 0 || input !== "@") {
        return undefined
      }

      return {
        parts: [
          {
            stroke: { name: "custom-visible", ctrl: false, shift: false, meta: false, super: false },
            display: "custom-visible",
            matchKey: "custom:stroke",
          },
        ],
        nextIndex: input.length,
      }
    })

    manager.registerEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return ["custom:stroke"]
    })

    manager.registerCommands([
      {
        name: "custom-match",
        run() {
          calls.push("custom")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "@", cmd: "custom-match" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["custom"])
    expect(getActiveKey(manager, "custom-visible")?.display).toBe("custom-visible")
  })

  test("supports binding expanders that split one key definition into multiple bindings", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    })

    manager.registerCommands([
      {
        name: "split-command",
        run() {
          calls.push("split")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x, y", cmd: "split-command" }],
    })

    expect(getActiveKeyNames(manager)).toEqual(["x", "y"])

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["split", "split"])
  })

  test("supports prepending binding expanders ahead of appended expanders", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    })
    manager.prependBindingExpander(({ input }) => {
      if (!input.includes("~")) {
        return undefined
      }

      return [input.replaceAll("~", "")]
    })

    manager.registerCommands([
      {
        name: "prepend-append",
        run() {
          calls.push("hit")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "~x,~y", cmd: "prepend-append" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["hit", "hit"])
  })

  test("binding expanders can use layer fields for optional emacs-style key strings", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerLayerFields({
      emacsStyle(value) {
        if (typeof value !== "boolean") {
          throw new Error('Keymap layer field "emacsStyle" must be a boolean')
        }
      },
    })

    manager.appendBindingExpander(({ input, layer }) => {
      if (layer.emacsStyle !== true) {
        return undefined
      }

      const strokes = input.trim().split(/\s+/).filter(Boolean)

      if (strokes.length <= 1) {
        return undefined
      }

      const tokenized: string[] = []
      for (const stroke of strokes) {
        const match = /^ctrl\+([a-z0-9])$/i.exec(stroke)
        if (!match || !match[1]) {
          return undefined
        }

        tokenized.push(`<c-${match[1].toLowerCase()}>`)
      }

      return [tokenized.join("")]
    })

    manager.registerToken({ token: "<c-x>", key: { name: "x", ctrl: true } })
    manager.registerToken({ token: "<c-s>", key: { name: "s", ctrl: true } })
    manager.registerCommands([
      {
        name: "save-buffer",
        run() {
          calls.push("save")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      emacsStyle: true,
      bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("s", { ctrl: true })

    expect(calls).toEqual(["save"])

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
      })
    }).toThrow('Invalid key "ctrl+x ctrl+s": multiple key names are not supported')
  })

  test("clearBindingExpanders allows replacing the expander chain", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    })
    manager.clearBindingExpanders()

    manager.appendBindingExpander(({ input }) => {
      if (!input.includes("|")) {
        return undefined
      }

      return input
        .split("|")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    })

    manager.registerCommands([
      {
        name: "comma-command",
        run() {
          calls.push("comma")
        },
      },
      {
        name: "pipe-command",
        run() {
          calls.push("pipe")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "a,b", cmd: "comma-command" }],
    })
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x|y", cmd: "pipe-command" }],
    })

    mockInput.pressKey("a")
    expect(calls).toEqual([])

    mockInput.pressKey(",")
    mockInput.pressKey("b")
    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["comma", "pipe", "pipe"])
  })

  test("can dispose binding compilers to stop transforming future layer registrations", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const offCompiler = manager.registerBindingCompiler((binding, ctx) => {
      if (binding.blocked !== true) {
        return
      }

      ctx.skipOriginal()
    })

    manager.registerCommands([
      {
        name: "blocked",
        run() {
          calls.push("blocked")
        },
      },
      {
        name: "active",
        run() {
          calls.push("active")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", blocked: true, cmd: "blocked" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    offCompiler()

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "y", blocked: true, cmd: "active" }],
    })

    mockInput.pressKey("y")
    expect(calls).toEqual(["active"])
  })

  test("throws when a binding expander returns an empty expansion", () => {
    const manager = getKeymapManager(renderer)

    manager.appendBindingExpander(() => {
      return []
    })

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).toThrow('Keymap binding expander must return at least one key sequence for "x"')
  })

  test("throws when a binding parser does not advance the input", () => {
    const manager = getKeymapManager(renderer)

    manager.clearBindingParsers()
    manager.appendBindingParser(() => {
      return { parts: [], nextIndex: 0 }
    })

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).toThrow('Keymap binding parser must advance the input for "x" at index 0')
  })

  test("supports release dispatch through registered fallback strokes", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "y")]
    })

    manager.registerCommands([
      {
        name: "release-action",
        run() {
          calls.push("release")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "y", event: "release", cmd: "release-action" }],
    })

    renderer.keyInput.emit(
      "keyrelease",
      new KeyEvent({
        name: "x",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "x",
        number: false,
        raw: "x",
        eventType: "release",
        source: "raw",
      }),
    )

    expect(calls).toEqual(["release"])
  })

  test("supports hyper key bindings", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "plain",
        run() {
          calls.push("plain")
        },
      },
      {
        name: "hyper",
        run() {
          calls.push("hyper")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "x", cmd: "plain" },
        { key: "hyper+x", cmd: "hyper" },
      ],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[27;17;120~"))
    mockInput.pressKey("x")

    expect(calls).toEqual(["hyper", "plain"])
  })

  test("passes lock-state flags to command handlers", async () => {
    renderer.destroy()
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput

    const manager = getKeymapManager(renderer)
    const calls: Array<{ capsLock: boolean; numLock: boolean }> = []

    manager.registerCommands([
      {
        name: "inspect-locks",
        run({ event }) {
          calls.push({
            capsLock: event.capsLock === true,
            numLock: event.numLock === true,
          })
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "a", cmd: "inspect-locks" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[97;193u"))

    expect(calls).toEqual([{ capsLock: true, numLock: true }])
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

  test("throws when duplicate command names are registered", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([{ name: "dup", run() {} }])

    expect(() => {
      manager.registerCommands([{ name: "dup", run() {} }])
    }).toThrow('Keymap command "dup" is already registered')
  })

  test("can dispose command resolvers and refresh existing bindings", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "external-run" }],
    })

    expect(getActiveKey(manager, "x")?.command).toBeUndefined()

    const offResolver = manager.registerCommandResolver((command) => {
      if (command !== "external-run") {
        return undefined
      }

      return {
        run() {
          calls.push("external")
        },
      }
    })

    expect(getActiveKey(manager, "x")?.command).toBe("external-run")

    mockInput.pressKey("x")
    expect(calls).toEqual(["external"])

    offResolver()

    expect(getActiveKey(manager, "x")?.command).toBeUndefined()

    mockInput.pressKey("x")
    expect(calls).toEqual(["external"])
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
    expect(activeBinding?.command).toBe("save-file")
    expect(activeBinding?.commandAttrs).toBeUndefined()
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.commandAttrs).toBeUndefined()
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

  test("includeMetadata re-evaluates unkeyed binding matchers on each read", () => {
    const manager = getKeymapManager(renderer)
    let enabled = false

    manager.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.match(() => enabled)
        ctx.attr("label", "Runtime binding")
      },
    })

    manager.registerCommands([{ name: "runtime-binding", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(getActiveKey(manager, "x", { includeMetadata: true })?.bindingAttrs).toBeUndefined()
    expect(getActiveKey(manager, "x", { includeMetadata: true })?.commandAttrs).toBeUndefined()

    enabled = true

    expect(getActiveKey(manager, "x", { includeMetadata: true })?.bindingAttrs).toEqual({ label: "Runtime binding" })
    expect(getActiveKey(manager, "x", { includeMetadata: true })?.commandAttrs).toBeUndefined()
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
          seen.push({ ...(ctx.command?.attrs ?? {}) })
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

    const activeKey = getActiveKey(manager, "x", { includeBindings: true, includeMetadata: true })
    expect(activeKey?.bindings?.[0]?.command).toBe("save-file")
    expect(activeKey?.bindings?.[0]?.commandAttrs).toEqual(attrs)
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.commandAttrs).toEqual(attrs)

    mockInput.pressKey("x")

    expect(seen).toEqual([attrs])
  })

  test("getCommands searches names by default and returns raw fields plus compiled attrs", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommandFields({
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    manager.registerCommands([
      {
        name: "save-current",
        namespace: "excommands",
        title: "Write File",
        usage: ":write <file>",
        tags: ["file", "write"],
        run() {},
      },
      {
        name: "session-reset",
        namespace: "excommands",
        title: "Reset Counters",
        run() {},
      },
      {
        name: "palette-help",
        namespace: "palette",
        title: "Open Help",
        run() {},
      },
    ])

    expect(manager.getCommands({ search: "save" }).map((command) => command.name)).toEqual(["save-current"])
    expect(manager.getCommands({ search: "write" })).toEqual([])
    expect(manager.getCommands({ search: "write", searchIn: ["title"] }).map((command) => command.name)).toEqual([
      "save-current",
    ])
    expect(manager.getCommands({ search: "write", searchIn: ["label"] }).map((command) => command.name)).toEqual([
      "save-current",
    ])
    expect(getCommand(manager, "save-current")).toEqual({
      name: "save-current",
      fields: {
        namespace: "excommands",
        title: "Write File",
        usage: ":write <file>",
        tags: ["file", "write"],
      },
      attrs: {
        label: "Write File",
      },
    })
  })

  test("getCommands supports namespace and filter queries across raw fields and attrs", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommandFields({
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    const offCommands = manager.registerCommands([
      {
        name: "save-current",
        namespace: "excommands",
        title: "Write File",
        usage: ":write <file>",
        tags: ["file", "write"],
        run() {},
      },
      {
        name: "session-reset",
        namespace: "excommands",
        title: "Reset Counters",
        tags: ["session"],
        run() {},
      },
      {
        name: "palette-help",
        namespace: "palette",
        title: "Open Help",
        tags: ["help"],
        run() {},
      },
      {
        name: "untagged-help",
        title: "excommands helper",
        tags: ["help"],
        run() {},
      },
    ])

    expect(manager.getCommands({ namespace: "excommands" }).map((command) => command.name)).toEqual([
      "save-current",
      "session-reset",
    ])
    expect(manager.getCommands({ namespace: ["palette", "missing"] }).map((command) => command.name)).toEqual([
      "palette-help",
    ])
    expect(manager.getCommands({ namespace: "excommands", search: "reset", searchIn: ["title"] }).map((command) => command.name)).toEqual([
      "session-reset",
    ])
    expect(manager.getCommands({ filter: { namespace: "excommands" } }).map((command) => command.name)).toEqual([
      "save-current",
      "session-reset",
    ])
    expect(manager.getCommands({ filter: { tags: "file" } }).map((command) => command.name)).toEqual([
      "save-current",
    ])
    expect(manager.getCommands({ filter: { label: "Reset Counters" } }).map((command) => command.name)).toEqual([
      "session-reset",
    ])
    expect(
      manager
        .getCommands({
          filter: {
            usage(value, command) {
              return (
                typeof value === "string" &&
                value.includes("<file>") &&
                command.fields.namespace === "excommands"
              )
            },
          },
        })
        .map((command) => command.name),
    ).toEqual(["save-current"])
    expect(
      manager
        .getCommands({
          namespace: "excommands",
          filter: {
            usage(value) {
              return typeof value === "string" && value.includes("<file>")
            },
          },
        })
        .map((command) => command.name),
    ).toEqual(["save-current"])
    expect(manager.getCommands({ filter: (command) => command.name === "palette-help" }).map((command) => command.name)).toEqual([
      "palette-help",
    ])

    offCommands()

    expect(manager.getCommands()).toEqual([])
  })

  test("getCommands returns immutable metadata records across repeated reads", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([
      {
        name: "save-current",
        tags: ["file", "write"],
        run() {},
      },
    ])

    const first = getCommand(manager, "save-current")
    expect(first).toBeDefined()
    expect(Object.isFrozen(first!.fields)).toBe(true)
    expect(Object.isFrozen(first!.fields.tags as object)).toBe(true)

    expect(() => {
      ;(first!.fields.tags as string[]).push("mutated")
    }).toThrow()

    const second = getCommand(manager, "save-current")
    expect(second).toBe(first)
    expect(second).toEqual({
      name: "save-current",
      fields: {
        tags: ["file", "write"],
      },
    })
  })

  test("keeps active key projections isolated across repeated reads", () => {
    const manager = getKeymapManager(renderer)

    manager.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
      group(value, ctx) {
        ctx.attr("group", value)
      },
    })
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
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const plain = getActiveKey(manager, "x")
    const metadataOnly = getActiveKey(manager, "x", { includeMetadata: true })
    const withBindings = getActiveKey(manager, "x", { includeBindings: true })
    const withBindingsAndMetadata = getActiveKey(manager, "x", { includeBindings: true, includeMetadata: true })
    const plainAgain = getActiveKey(manager, "x")

    const commandAttrs = {
      desc: "Save the current file",
      title: "Save File",
      category: "File",
    }
    const bindingAttrs = {
      desc: "Write current file",
      group: "File",
    }

    expect(plain?.bindings).toBeUndefined()
    expect(plain?.bindingAttrs).toBeUndefined()
    expect(plain?.commandAttrs).toBeUndefined()
    expect(plain?.command).toBe("save-file")

    expect(metadataOnly?.bindings).toBeUndefined()
    expect(metadataOnly?.command).toBe("save-file")
    expect(metadataOnly?.bindingAttrs).toEqual(bindingAttrs)
    expect(metadataOnly?.commandAttrs).toEqual(commandAttrs)

    expect(withBindings?.bindingAttrs).toBeUndefined()
    expect(withBindings?.commandAttrs).toBeUndefined()
    expect(withBindings?.command).toBe("save-file")
    expect(withBindings?.bindings?.[0]?.attrs).toEqual(bindingAttrs)
    expect(withBindings?.bindings?.[0]?.command).toBe("save-file")
    expect(withBindings?.bindings?.[0]?.commandAttrs).toEqual(commandAttrs)

    expect(withBindingsAndMetadata?.bindingAttrs).toEqual(bindingAttrs)
    expect(withBindingsAndMetadata?.commandAttrs).toEqual(commandAttrs)
    expect(withBindingsAndMetadata?.command).toBe("save-file")
    expect(withBindingsAndMetadata?.bindings?.[0]?.attrs).toEqual(bindingAttrs)
    expect(withBindingsAndMetadata?.bindings?.[0]?.command).toBe("save-file")
    expect(withBindingsAndMetadata?.bindings?.[0]?.commandAttrs).toEqual(commandAttrs)

    expect(plainAgain?.bindings).toBeUndefined()
    expect(plainAgain?.bindingAttrs).toBeUndefined()
    expect(plainAgain?.commandAttrs).toBeUndefined()
    expect(plainAgain?.command).toBe("save-file")
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
        matchKey: "d:0:0:0:0:0",
      },
    ])
    expect(getActiveKeyNames(manager)).toEqual(["d"])
    expect(getActiveKey(manager, "d")?.command).toBe("delete-line")
    expect(getActiveKey(manager, "d")?.display).toBe("d")

    mockInput.pressKey("d")

    expect(calls).toEqual(["delete-line"])
    expect(manager.getPendingSequence()).toEqual([])
  })

  test("hasPendingSequence reflects pending lifecycle", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    expect(manager.hasPendingSequence()).toBe(false)

    mockInput.pressKey("d")
    expect(manager.hasPendingSequence()).toBe(true)

    manager.popPendingSequence()
    expect(manager.hasPendingSequence()).toBe(false)

    mockInput.pressKey("d")
    expect(manager.hasPendingSequence()).toBe(true)

    manager.clearPendingSequence()
    expect(manager.hasPendingSequence()).toBe(false)
  })

  test("onKeyInput can be gated by hasPendingSequence", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "delete-line",
        run() {
          calls.push("delete")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    const off = manager.onKeyInput(({ event }) => {
      if (!manager.hasPendingSequence()) {
        return
      }

      calls.push(`pending:${event.name}`)
    })

    mockInput.pressKey("d")
    mockInput.pressKey("x")
    mockInput.pressKey("d")
    mockInput.pressKey("d")

    expect(calls).toEqual(["pending:x", "pending:d", "delete"])

    off()
    calls.length = 0

    mockInput.pressKey("d")
    mockInput.pressKey("x")

    expect(calls).toEqual([])
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

    manager.hook("pendingSequence", (sequence) => {
      changes.push(sequence.map((stroke) => stroke.name).join(""))
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    manager.popPendingSequence()
    manager.clearPendingSequence()

    expect(changes).toEqual(["d", "dc", "d", ""])
  })

  test("notifies state changes with the current pending sequence and active keys", () => {
    const manager = getKeymapManager(renderer)
    const snapshots: string[] = []

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

    manager.hook("state", () => {
      const pending = stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(manager).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    manager.popPendingSequence()
    manager.clearPendingSequence()

    expect(snapshots).toEqual(["d:c", "dc:a", "d:c", "<root>:d"])
  })

  test("coalesces state changes when runtime data clears a pending sequence", () => {
    const manager = getKeymapManager(renderer)
    const snapshots: string[] = []

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

    manager.hook("state", () => {
      const pending = stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(manager).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    manager.setData("vim.mode", "visual")

    expect(snapshots).toEqual(["<root>:<none>"])
    expect(manager.getPendingSequence()).toEqual([])
  })

  test("notifies state changes when focus changes active layers and direct blur clears focus", () => {
    const manager = getKeymapManager(renderer)
    const target = createFocusableBox("state-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    manager.registerCommands([{ name: "local", run() {} }])
    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    manager.hook("state", () => {
      snapshots.push(getActiveKeyNames(manager).join(",") || "<none>")
    })

    target.focus()
    target.blur()

    expect(snapshots).toEqual(["x", "<none>"])
  })

  test("coalesces state changes when blur clears a pending sequence", () => {
    const manager = getKeymapManager(renderer)
    const target = createFocusableBox("pending-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      target,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    target.focus()
    mockInput.pressKey("d")

    manager.hook("state", () => {
      const pending = stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(manager).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    target.blur()

    expect(snapshots).toEqual(["<root>:<none>"])
    expect(manager.getPendingSequence()).toEqual([])
  })

  test("clears global pending sequences when focus changes to another renderable", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    const first = createFocusableBox("global-pending-first")
    const second = createFocusableBox("global-pending-second")
    renderer.root.add(first)
    renderer.root.add(second)

    manager.registerCommands([
      {
        name: "global-delete",
        run() {
          calls.push("global")
        },
      },
      {
        name: "local-delete",
        run() {
          calls.push("local")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "global-delete" }],
    })
    manager.registerLayer({
      target: second,
      bindings: [{ key: "d", cmd: "local-delete" }],
    })

    first.focus()
    mockInput.pressKey("d")

    expect(manager.getPendingSequence()).toHaveLength(1)

    second.focus()

    expect(manager.getPendingSequence()).toEqual([])

    mockInput.pressKey("d")

    expect(calls).toEqual(["local"])
  })

  test("clears global pending sequences when direct blur clears focus", () => {
    const manager = getKeymapManager(renderer)
    const target = createFocusableBox("global-pending-blur")

    renderer.root.add(target)

    manager.registerCommands([{ name: "global-delete", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "global-delete" }],
    })

    target.focus()
    mockInput.pressKey("d")

    expect(manager.getPendingSequence()).toHaveLength(1)

    target.blur()

    expect(manager.getPendingSequence()).toEqual([])
  })

  test("can unsubscribe state change listeners", () => {
    const manager = getKeymapManager(renderer)
    const target = createFocusableBox("unsubscribe-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    manager.registerCommands([{ name: "local", run() {} }])
    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    const off = manager.hook("state", () => {
      snapshots.push(getActiveKeyNames(manager).join(",") || "<none>")
    })

    off()
    target.focus()

    expect(snapshots).toEqual([])
  })

  test("uses a stable state change listener snapshot when listeners unsubscribe mid-notification", () => {
    const manager = getKeymapManager(renderer)
    const target = createFocusableBox("state-snapshot-target")
    const calls: string[] = []

    renderer.root.add(target)

    manager.registerCommands([{ name: "local", run() {} }])
    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    let offSecond!: () => void

    manager.hook("state", () => {
      calls.push(`first:${getActiveKeyNames(manager).join(",") || "<none>"}`)
      offSecond()
    })

    offSecond = manager.hook("state", () => {
      calls.push(`second:${getActiveKeyNames(manager).join(",") || "<none>"}`)
    })

    target.focus()
    target.blur()

    expect(calls).toEqual(["first:x", "second:x", "first:<none>"])
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
    expect(getActiveKeyDisplay(manager, "g")?.command).toBeUndefined()
    expect(manager.getPendingSequenceParts()).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
        matchKey: "x:1:0:0:0:0",
      },
    ])
    expect(getActiveKey(manager, "g")?.command).toBeUndefined()

    mockInput.pressKey("g")

    expect(getActiveKeyNames(manager)).toEqual(["d"])
    expect(stringifyKeySequence(manager.getPendingSequenceParts(), { preferDisplay: true })).toBe("<leader>g")
    expect(getActiveKey(manager, "d")?.command).toBe("go-definition")

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

    expect(getActiveKeyDisplay(manager, "<leader>")?.command).toBeUndefined()
    expect(stringifyKeyStroke(getActiveKeyDisplay(manager, "<leader>")!, { preferDisplay: true })).toBe("<leader>")
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

  test("ignores unknown binding fields", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "noop",
        run() {
          calls.push("noop")
        },
      },
    ])

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "x", mode: "normal", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKey(manager, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(calls).toEqual(["noop"])
  })

  test("ignores unknown layer fields", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "noop",
        run() {
          calls.push("noop")
        },
      },
    ])

    expect(() => {
      manager.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKey(manager, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(calls).toEqual(["noop"])
  })

  test("stores raw command fields without requiring command field compilers", () => {
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    expect(() => {
      manager.registerCommands([
        {
          name: "save-file",
          desc: "Save the current file",
          usage: ":write <file>",
          tags: ["file", "write"],
          run() {
            calls.push("save-file")
          },
        },
      ])
    }).not.toThrow()

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    expect(getCommand(manager, "save-file")).toEqual({
      name: "save-file",
      fields: {
        desc: "Save the current file",
        usage: ":write <file>",
        tags: ["file", "write"],
      },
    })

    expect(getActiveKey(manager, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(calls).toEqual(["save-file"])
  })

  test("logs warnings only for unknown binding and layer fields when logger is configured", () => {
    const warnings: string[] = []
    const manager = getKeymapManager(renderer, {
      logger: {
        warn(...args) {
          warnings.push(args.map((value) => String(value)).join(" "))
        },
      },
    })

    manager.registerCommands([
      {
        name: "save-file",
        desc: "Save the current file",
        run() {},
      },
      {
        name: "open-file",
        desc: "Open the current file",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      mode: "normal",
      bindings: [
        { key: "x", when: "normal", cmd: "save-file" },
        { key: "y", when: "insert", cmd: "open-file" },
      ],
    })

    expect(warnings).toEqual([
      '[Keymap] Unknown layer field "mode" was ignored',
      '[Keymap] Unknown binding field "when" was ignored',
    ])
  })

  test("logs unknown token warnings when logger is configured", () => {
    const warnings: string[] = []
    const manager = getKeymapManager(renderer, {
      logger: {
        warn(...args) {
          warnings.push(args.map((value) => String(value)).join(" "))
        },
      },
    })

    manager.registerCommands([{ name: "noop", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "<leader>x", cmd: "noop" },
        { key: "<leader>y", cmd: "noop" },
      ],
    })

    expect(warnings).toEqual(['[Keymap] Unknown token "<leader>" in key sequence "<leader>x" was ignored'])
  })

  test("logs unresolved string commands through logger.warn", () => {
    const warnings: string[] = []
    const manager = getKeymapManager(renderer, {
      logger: {
        warn(...args) {
          warnings.push(args.map((value) => String(value)).join(" "))
        },
      },
    })

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "missing-command" }],
    })

    expect(warnings).toEqual(['[Keymap] Unresolved command "missing-command" for binding "x" in global layer'])
  })

  test("notifies unresolved command listeners with command, binding, scope, and target context", () => {
    const manager = getKeymapManager(renderer)
    const target = createFocusableBox("unresolved-target")
    const calls: Array<{ command: string; binding: string; scope: string; targetId?: string }> = []

    renderer.root.add(target)

    manager.hook("unresolvedCommand", (ctx) => {
      calls.push({
        command: ctx.command,
        binding: stringifyKeySequence(ctx.binding.sequence, { preferDisplay: true }),
        scope: ctx.scope,
        targetId: ctx.target?.id,
      })
    })

    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "missing-command" }],
    })

    expect(calls).toEqual([
      {
        command: "missing-command",
        binding: "x",
        scope: "focus-within",
        targetId: "unresolved-target",
      },
    ])
  })

  test("logs runtime matcher failures through logger.error", () => {
    const warnings: string[] = []
    const errors: string[] = []
    const manager = getKeymapManager(renderer, {
      logger: {
        warn(...args) {
          warnings.push(args.map((value) => String(value)).join(" "))
        },
        error(...args) {
          errors.push(args.map((value) => String(value)).join(" "))
        },
      },
    })

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

    manager.registerCommands([{ name: "runtime-binding", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(() => manager.getActiveKeys()).not.toThrow()
    expect(errors.some((message) => message.includes("Error evaluating runtime matcher from field active:"))).toBe(true)
    expect(warnings).toEqual([])
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

  test("allows a non-dispatch binding to label a prefix", () => {
    const manager = getKeymapManager(renderer)

    manager.registerBindingFields({
      group(value, ctx) {
        ctx.attr("group", value)
      },
    })

    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "d", group: "Delete" },
        { key: "dd", cmd: "delete-line" },
      ],
    })

    const activeKey = getActiveKey(manager, "d", { includeBindings: true, includeMetadata: true })

    expect(activeKey?.command).toBeUndefined()
    expect(activeKey?.bindingAttrs).toEqual({ group: "Delete" })
    expect(activeKey?.bindings?.map((binding) => binding.command)).toEqual([undefined])
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

  test("supports declarative release bindings", async () => {
    renderer.destroy()
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput

    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "release-command",
        run() {
          calls.push("release")
        },
      },
      {
        name: "press-command",
        run() {
          calls.push("press")
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "a", cmd: "release-command", event: "release" },
        { key: "b", cmd: "press-command" },
      ],
    })

    expect(getActiveKeyNames(manager)).toEqual(["b"])

    mockInput.pressKey("a")
    expect(calls).toEqual([])

    renderer.stdin.emit("data", Buffer.from("\x1b[97;1:3u"))
    expect(calls).toEqual(["release"])

    mockInput.pressKey("b")
    expect(calls).toEqual(["release", "press"])
  })

  test("rejects release bindings with multiple strokes", () => {
    const manager = getKeymapManager(renderer)

    manager.registerCommands([{ name: "noop", run() {} }])

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "dd", cmd: "noop", event: "release" }],
      })
    }).toThrow("Keymap release bindings only support a single key stroke")
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

  test("passes target and runtime data to commands", () => {
    const manager = getKeymapManager(renderer)
    const seen: Array<{ target: string; command: string; mode: string }> = []

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
            command: ctx.command?.name ?? "none",
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
      bindings: [{ key: "x", mode: "normal", cmd: "record" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(seen).toEqual([{ target: "ctx-parent", command: "record", mode: "normal" }])
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

    const off = manager.hook("pendingSequence", (sequence) => {
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

    manager.hook("pendingSequence", (sequence) => {
      calls.push(`first:${sequence.map((stroke) => stroke.name).join("")}`)
      offSecond()
    })

    offSecond = manager.hook("pendingSequence", (sequence) => {
      calls.push(`second:${sequence.map((stroke) => stroke.name).join("")}`)
    })

    mockInput.pressKey("d")
    manager.clearPendingSequence()

    expect(calls).toEqual(["first:d", "second:d", "first:"])
  })

  test("logs pending sequence listener failures and continues notifying remaining listeners", () => {
    const errors: string[] = []
    const changes: string[] = []
    const manager = getKeymapManager(renderer, {
      logger: {
        error(...args) {
          errors.push(args.map((value) => String(value)).join(" "))
        },
      },
    })

    manager.registerCommands([{ name: "delete-ca", run() {} }])
    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    manager.hook("pendingSequence", () => {
      throw new Error("boom")
    })
    manager.hook("pendingSequence", (sequence) => {
      changes.push(sequence.map((stroke) => stroke.name).join(""))
    })

    mockInput.pressKey("d")

    expect(changes).toEqual(["d"])
    expect(errors.some((message) => message.includes("Error in pending sequence hook:"))).toBe(true)
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
    expect(getActiveKeyDisplay(manager, "<leader>")?.command).toBeUndefined()

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

    expect(getActiveKeyDisplay(manager, "<leader>")?.command).toBe("leader-only")

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

    manager.registerCommands([{ name: "noop", run() {} }])

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
    }).not.toThrow()

    expect(getActiveKeyNames(manager)).toContain("x")

    const offBindingFields = manager.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    offBindingFields()

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "y", mode: "normal", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames(manager)).toContain("y")

    const offCommandFields = manager.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
    })
    offCommandFields()

    expect(() => {
      manager.registerCommands([
        {
          name: "noop-with-desc",
          desc: "No operation",
          run() {},
        },
      ])
    }).not.toThrow()

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "z", cmd: "noop-with-desc" }],
    })

    expect(getActiveKeyNames(manager)).toContain("z")
  })

  test("getActiveKeys follows dispatch order and fallthrough across layers", () => {
    const manager = getKeymapManager(renderer)
    const target = createFocusableBox("dispatch-active-target")

    renderer.root.add(target)

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
      bindings: [
        { key: "x", cmd: "save", desc: "Global x" },
        { key: "y", cmd: "help", desc: "Global y" },
      ],
    })
    manager.registerLayer({
      target,
      bindings: [
        { key: "x", cmd: "help", desc: "Local x" },
        { key: "y", cmd: "save", desc: "Local y", fallthrough: true },
      ],
    })

    target.focus()

    const activeX = getActiveKey(manager, "x", { includeBindings: true, includeMetadata: true })

    expect(activeX?.command).toBe("help")
    expect(activeX?.bindings?.map((binding) => binding.command)).toEqual(["help"])
    expect(activeX?.bindingAttrs).toEqual({ desc: "Local x" })

    const activeY = getActiveKey(manager, "y", { includeBindings: true, includeMetadata: true })

    expect(activeY?.command).toBe("save")
    expect(activeY?.bindings?.map((binding) => binding.command)).toEqual(["save", "help"])
    expect(activeY?.bindingAttrs).toEqual({ desc: "Local y" })
  })

  test("getActiveKeys uses the first matching prefix layer before lower exact layers", () => {
    const manager = getKeymapManager(renderer)
    const target = createFocusableBox("prefix-dispatch-target")

    renderer.root.add(target)

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
      bindings: [{ key: "ctrl+x", cmd: "plain" }],
    })
    manager.registerLayer({
      target,
      bindings: [{ key: "<leader>a", cmd: "leader" }],
    })

    target.focus()

    const activeKey = manager
      .getActiveKeys()
      .find((candidate) => candidate.stroke.name === "x" && candidate.stroke.ctrl)

    expect(activeKey?.command).toBeUndefined()
    expect(activeKey?.continues).toBe(true)
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

  test("requires registered token keys to resolve to a single key stroke", () => {
    const manager = getKeymapManager(renderer)

    expect(() => {
      manager.registerToken({ token: "<leader>", key: "dd" })
    }).toThrow('Invalid key "dd": expected a single key stroke')
  })
})
