import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { KeyEvent } from "../../lib/KeyHandler.js"
import { BoxRenderable } from "../../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../testing.js"
import {
  defaultBindingParser,
  defaultBindingSyntax,
  getActionMap,
  stringifyKeySequence,
  stringifyKeyStroke,
  type ActiveKey,
  type ActiveKeyOptions,
  type CommandRecord,
  type ActionMap,
  type ReactiveMatcher,
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

function getActiveKey(actionMap: ActionMap, name: string, options?: ActiveKeyOptions): ActiveKey | undefined {
  return actionMap.getActiveKeys(options).find((candidate) => candidate.stroke.name === name)
}

function getActiveKeyNames(actionMap: ActionMap): string[] {
  return actionMap
    .getActiveKeys()
    .map((candidate) => candidate.stroke.name)
    .sort()
}

function getCommand(actionMap: ActionMap, name: string) {
  return actionMap.getCommands().find((candidate) => candidate.name === name)
}

function getActiveKeyDisplay(actionMap: ActionMap, display: string, options?: ActiveKeyOptions): ActiveKey | undefined {
  return actionMap.getActiveKeys(options).find((candidate) => candidate.display === display)
}

function captureDiagnostics(actionMap: ActionMap): { warnings: string[]; errors: string[] } {
  const warnings: string[] = []
  const errors: string[] = []

  actionMap.on("warning", (event) => {
    warnings.push(event.message)
  })
  actionMap.on("error", (event) => {
    errors.push(event.message)
  })

  return { warnings, errors }
}

function getMatchKeyForEventName(event: KeyEvent, name: string): string {
  const normalizedName = name === " " ? "space" : name.trim().toLowerCase()
  if (!normalizedName) {
    throw new Error("Expected non-empty key name")
  }

  return `${normalizedName}:${event.ctrl ? 1 : 0}:${event.shift ? 1 : 0}:${event.meta ? 1 : 0}:${event.super ? 1 : 0}:${event.hyper ? 1 : 0}`
}

// Tiny reactive-matcher test helper that exposes subscription counts.
interface ReactiveBoolean extends ReactiveMatcher {
  set(next: boolean): void
  readonly subscriptions: number
  readonly subscribeCalls: number
  readonly disposeCalls: number
}

function createReactiveBoolean(initial: boolean): ReactiveBoolean {
  let current = initial
  const listeners = new Set<() => void>()
  let subscribeCalls = 0
  let disposeCalls = 0

  const matcher: ReactiveBoolean = {
    get() {
      return current
    },
    subscribe(onChange) {
      subscribeCalls += 1
      listeners.add(onChange)
      return () => {
        disposeCalls += 1
        listeners.delete(onChange)
      }
    },
    set(next) {
      if (current === next) {
        return
      }
      current = next
      for (const fn of listeners) {
        fn()
      }
    },
    get subscriptions() {
      return listeners.size
    },
    get subscribeCalls() {
      return subscribeCalls
    },
    get disposeCalls() {
      return disposeCalls
    },
  }

  return matcher
}

describe("action map", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("returns the same action map for the same renderer", () => {
    const first = getActionMap(renderer)
    const second = getActionMap(renderer)

    expect(first).toBe(second)
  })

  test("throws when requesting an action map for a destroyed renderer", () => {
    getActionMap(renderer)
    renderer.destroy()

    expect(() => getActionMap(renderer)).toThrow("Cannot create an action map for a destroyed renderer")
  })

  test("keeps non-renderer state and throws on renderer-backed reads after renderer destroy", () => {
    const actionMap = getActionMap(renderer)

    actionMap.setData("mode", "normal")
    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "noop" }],
    })

    renderer.destroy()

    expect(actionMap.getData("mode")).toBe("normal")
    expect(actionMap.getCommands().map((command) => command.name)).toEqual(["noop"])
    expect(
      actionMap.createKeyMatcher("x")({
        name: "x",
        ctrl: false,
        shift: false,
        meta: false,
        super: false,
        hyper: false,
      }),
    ).toBe(true)

    expect(() => actionMap.getActiveKeys()).toThrow("Cannot use an action map after its renderer was destroyed")
  })

  test("defaults targetless layers to global scope", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "global-default",
        run() {
          calls.push("global")
        },
      },
    ] })

    actionMap.registerLayer({
      bindings: [{ key: "x", cmd: "global-default" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
  })

  test("supports function binding commands", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const handler = () => {
      calls.push("handled")
    }

    actionMap.registerLayer({
      bindings: [{ key: "x", cmd: handler }],
    })

    expect(getActiveKey(actionMap, "x")?.command).toBe(handler)
    expect(getActiveKey(actionMap, "x", { includeBindings: true })?.bindings?.[0]?.command).toBe(handler)

    mockInput.pressKey("x")

    expect(calls).toEqual(["handled"])
  })

  test("runCommand executes a registered command and only includes command metadata when requested", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "save-file",
        run() {
          calls.push("save-file")
        },
      },
    ] })

    expect(actionMap.runCommand("save-file")).toEqual({ ok: true })
    expect(actionMap.runCommand("save-file", { includeCommand: true })).toEqual({
      ok: true,
      command: {
        name: "save-file",
        fields: {},
      },
    })
    expect(actionMap.runCommand("missing-command")).toEqual({ ok: false, reason: "not-found" })
    expect(calls).toEqual(["save-file", "save-file"])
  })

  test("normalizeCommandName exposes command normalization on the public facade", () => {
    const actionMap = getActionMap(renderer)

    expect(actionMap.normalizeCommandName("  save-file  ")).toBe("save-file")
    expect(() => actionMap.normalizeCommandName("save file")).toThrow(
      'Invalid action map command name "save file": command names cannot contain whitespace',
    )
  })

  test("active layered commands take precedence over command resolvers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "shared-command",
        run() {
          calls.push("registered")
        },
      },
    ] })

    actionMap.appendCommandResolver((command) => {
      if (command !== "shared-command") {
        return undefined
      }

      return {
        run() {
          calls.push("resolver")
        },
      }
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "shared-command" }],
    })

    mockInput.pressKey("x")
    expect(actionMap.runCommand("shared-command")).toEqual({ ok: true })
    expect(calls).toEqual(["registered", "registered"])
  })

  test("prependCommandResolver runs before appended resolvers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendCommandResolver((command) => {
      if (command !== "shared-command") {
        return undefined
      }

      return {
        run() {
          calls.push("append")
        },
      }
    })
    actionMap.prependCommandResolver((command) => {
      if (command !== "shared-command") {
        return undefined
      }

      return {
        run() {
          calls.push("prepend")
        },
      }
    })

    expect(actionMap.runCommand("shared-command")).toEqual({ ok: true })
    expect(calls).toEqual(["prepend"])
  })

  test("clearCommandResolvers removes registered command resolvers", () => {
    const actionMap = getActionMap(renderer)

    actionMap.appendCommandResolver((command) => {
      if (command !== "shared-command") {
        return undefined
      }

      return {
        run() {},
      }
    })

    expect(actionMap.runCommand("shared-command")).toEqual({ ok: true })

    actionMap.clearCommandResolvers()

    expect(actionMap.runCommand("shared-command")).toEqual({ ok: false, reason: "not-found" })
  })

  test("layer commands resolve bindings, shadow globals, and expose local metadata", () => {
    const actionMap = getActionMap(renderer)
    const { warnings } = captureDiagnostics(actionMap)
    const calls: string[] = []
    const target = createFocusableBox("layer-command-target")

    renderer.root.add(target)

    actionMap.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "submit",
        run() {
          calls.push("global")
        },
      },
    ] })

    actionMap.registerLayer({
      target,
      commands: [
        {
          name: "submit",
          desc: "Local submit",
          run() {
            calls.push("local")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "submit" }],
    })

    expect(actionMap.runCommand("submit")).toEqual({ ok: true })

    target.focus()

    expect(getActiveKey(actionMap, "x", { includeMetadata: true })?.commandAttrs).toEqual({ desc: "Local submit" })

    mockInput.pressKey("x")

    expect(actionMap.runCommand("submit", { includeCommand: true })).toEqual({
      ok: true,
      command: {
        name: "submit",
        fields: { desc: "Local submit" },
        attrs: { desc: "Local submit" },
      },
    })
    expect(calls).toEqual(["global", "local", "local"])
    expect(warnings).toEqual([])
  })

  test("runCommand falls through rejecting layer commands in active-layer order", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    const parent = createFocusableBox("layer-command-parent")
    const child = createFocusableBox("layer-command-child")

    renderer.root.add(parent)
    parent.add(child)

    actionMap.registerLayer({
      target: parent,
      commands: [
        {
          name: "submit",
          run() {
            calls.push("parent")
          },
        },
      ],
    })

    actionMap.registerLayer({
      target: child,
      commands: [
        {
          name: "submit",
          run() {
            calls.push("child")
            return false
          },
        },
      ],
    })

    child.focus()

    expect(actionMap.runCommand("submit")).toEqual({ ok: true })
    expect(calls).toEqual(["child", "parent"])
  })

  test("runCommand falls through rejecting layer commands to globals", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    const target = createFocusableBox("layer-command-fallback-target")

    renderer.root.add(target)

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "submit",
        run() {
          calls.push("global")
        },
      },
    ] })

    actionMap.registerLayer({
      target,
      commands: [
        {
          name: "submit",
          run() {
            calls.push("local")
            return false
          },
        },
      ],
    })

    target.focus()

    expect(actionMap.runCommand("submit")).toEqual({ ok: true })
    expect(calls).toEqual(["local", "global"])
  })

  test("supports command-only layers for scoped runCommand resolution", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    const target = createFocusableBox("command-only-layer-target")

    renderer.root.add(target)

    const off = actionMap.registerLayer({
      target,
      commands: [
        {
          name: "submit",
          run() {
            calls.push("local")
          },
        },
      ],
    })

    expect(actionMap.runCommand("submit")).toEqual({ ok: false, reason: "not-found" })

    target.focus()

    expect(actionMap.runCommand("submit")).toEqual({ ok: true })

    off()

    expect(actionMap.runCommand("submit")).toEqual({ ok: false, reason: "not-found" })
    expect(calls).toEqual(["local"])
  })

  test("refreshing global command resolution keeps same-name layer command bindings", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    const target = createFocusableBox("layer-command-refresh-target")

    renderer.root.add(target)

    actionMap.registerLayer({
      target,
      commands: [
        {
          name: "shared",
          run() {
            calls.push("local")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "shared" }],
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "shared",
        run() {
          calls.push("global")
        },
      },
    ] })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["local"])
  })

  test("treats thrown command resolvers as errors without emitting unresolved warnings", () => {
    const actionMap = getActionMap(renderer)
    const { warnings, errors } = captureDiagnostics(actionMap)

    actionMap.appendCommandResolver(() => {
      throw new Error("resolver boom")
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "x", cmd: "external-run" }],
      })
    }).not.toThrow()

    expect(getActiveKey(actionMap, "x")?.command).toBeUndefined()
    expect(warnings).toEqual([])
    expect(actionMap.runCommand("external-run")).toEqual({ ok: false, reason: "error" })
    expect(errors).toHaveLength(2)
    expect(errors.every((message) => message.includes('Error in command resolver for "external-run":'))).toBe(true)
  })

  test("prefers direct stroke matches over registered fallback strokes", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "y")]
    })

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "g")]
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "delete-line",
        run() {
          calls.push("delete-line")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "ga", cmd: "delete-line" }],
    })

    mockInput.pressKey("x")
    expect(stringifyKeySequence(actionMap.getPendingSequence(), { preferDisplay: true })).toBe("g")

    mockInput.pressKey("a")

    expect(calls).toEqual(["delete-line"])
    expect(actionMap.getPendingSequence()).toEqual([])
  })

  test("supports custom binding parsers ahead of the default parser", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.prependBindingParser(({ input, index, tokens }) => {
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

    actionMap.registerToken({ name: "[leader]", key: { name: "x", ctrl: true } })
    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "leader-action",
        run() {
          calls.push("leader")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "[leader]d", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("d")

    expect(calls).toEqual(["leader"])
  })

  test("clearBindingParsers allows replacing the default parser", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.clearBindingParsers()
    actionMap.appendBindingParser(({ input, index, tokens }) => {
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

    actionMap.registerToken({ name: "[leader]", key: { name: "x", ctrl: true } })
    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "leader-only",
        run() {
          calls.push("leader")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "[leader]", cmd: "leader-only" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["leader"])
  })

  test("clearBindingSyntax disables object keys and token registration until syntax is restored", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    const { errors } = captureDiagnostics(actionMap)

    actionMap.clearBindingSyntax()

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: { name: "x" }, cmd: "object" }],
      })
    }).not.toThrow()

    expect(() => {
      actionMap.registerToken({ name: "<leader>", key: { name: "x", ctrl: true } })
    }).not.toThrow()

    expect(errors).toEqual(["No action map binding syntax is registered", "No action map binding syntax is registered"])

    expect(getActiveKey(actionMap, "x")).toBeUndefined()

    actionMap.setBindingSyntax(defaultBindingSyntax)

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: { name: "x" }, cmd: "object" }],
    })
    actionMap.registerToken({ name: "<leader>", key: { name: "x", ctrl: true } })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>", cmd: "token" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["object", "token"])
  })

  test("supports case-sensitive token names when parser and binding syntax are case-sensitive", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.clearBindingParsers()
    actionMap.appendBindingParser(({ input, index, tokens }) => {
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
    actionMap.appendBindingParser(defaultBindingParser)

    actionMap.clearBindingSyntax()
    actionMap.setBindingSyntax({
      normalizeTokenName(token) {
        const normalized = token.trim()
        if (!normalized) {
          throw new Error("Invalid action map token: token cannot be empty")
        }

        return normalized
      },
      parseObjectKey(key) {
        return defaultBindingSyntax.parseObjectKey(key)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "case-token",
        run() {
          calls.push("case-token")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "[Leader]d", cmd: "case-token" }],
    })

    actionMap.registerToken({ name: "[Leader]", key: { name: "x", ctrl: true } })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("d")

    expect(calls).toEqual(["case-token"])
  })

  test("createKeyMatcher uses the action map's current parser and token configuration", () => {
    const actionMap = getActionMap(renderer)

    actionMap.clearBindingParsers()
    actionMap.appendBindingParser(({ input, index, tokens }) => {
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
    actionMap.appendBindingParser(defaultBindingParser)

    actionMap.clearBindingSyntax()
    actionMap.setBindingSyntax({
      normalizeTokenName(token) {
        const normalized = token.trim()
        if (!normalized) {
          throw new Error("Invalid action map token: token cannot be empty")
        }

        return normalized
      },
      parseObjectKey(key) {
        return defaultBindingSyntax.parseObjectKey(key)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "case-token",
        run() {},
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "[Leader]d", cmd: "case-token" }],
    })

    actionMap.registerToken({ name: "[Leader]", key: { name: "x", ctrl: true } })

    const matchesLeader = actionMap.createKeyMatcher("[Leader]")

    mockInput.pressKey("x", { ctrl: true })

    const [head] = actionMap.getPendingSequence()
    expect(matchesLeader(head)).toBe(true)
  })

  test("clearEventMatchResolvers disables default event matching until custom resolvers are added", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "run",
        run() {
          calls.push("run")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "run" }],
    })

    actionMap.clearEventMatchResolvers()
    mockInput.pressKey("x")
    expect(calls).toEqual([])

    actionMap.appendEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "x")]
    })

    mockInput.pressKey("x")
    expect(calls).toEqual(["run"])
  })

  test("can dispose registered event match resolvers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const offResolver = actionMap.appendEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "y")]
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "fallback",
        run() {
          calls.push("fallback")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "y", cmd: "fallback" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual(["fallback"])

    offResolver()

    mockInput.pressKey("x")
    expect(calls).toEqual(["fallback"])
  })

  test("prependEventMatchResolver runs before appended resolvers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "y")]
    })
    actionMap.prependEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "z")]
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "fallback",
        run() {
          calls.push("fallback")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "z", cmd: "fallback" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["fallback"])
  })

  test("matches bindings using parser-provided match keys", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.prependBindingParser(({ input, index }) => {
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

    actionMap.appendEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return ["custom:stroke"]
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "custom-match",
        run() {
          calls.push("custom")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "@", cmd: "custom-match" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["custom"])
    expect(getActiveKey(actionMap, "custom-visible")?.display).toBe("custom-visible")
  })

  test("supports binding expanders that split one key definition into multiple bindings", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "split-command",
        run() {
          calls.push("split")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x, y", cmd: "split-command" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual(["x", "y"])

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["split", "split"])
  })

  test("supports prepending binding expanders ahead of appended expanders", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    })
    actionMap.prependBindingExpander(({ input }) => {
      if (!input.includes("~")) {
        return undefined
      }

      return [input.replaceAll("~", "")]
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "prepend-append",
        run() {
          calls.push("hit")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "~x,~y", cmd: "prepend-append" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["hit", "hit"])
  })

  test("prependBindingTransformer runs before appended transformers", () => {
    const actionMap = getActionMap(renderer)
    const transformerOrder: string[] = []

    actionMap.appendBindingTransformer((binding, ctx) => {
      transformerOrder.push("append")
      ctx.add({ ...binding, sequence: [ctx.parseKey("y")] })
      ctx.skipOriginal()
    })
    actionMap.prependBindingTransformer((binding, ctx) => {
      transformerOrder.push("prepend")
      ctx.add({ ...binding, sequence: [ctx.parseKey("x")] })
      ctx.skipOriginal()
    })

    actionMap.registerLayer({ scope: "global", commands: [
      { name: "submit", run() {} },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "z", cmd: "submit" }],
    })

    expect(transformerOrder).toEqual(["prepend", "append"])
  })

  test("clearBindingTransformers removes registered binding transformers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendBindingTransformer((binding, ctx) => {
      ctx.add({ ...binding, sequence: [ctx.parseKey("x")] })
      ctx.skipOriginal()
    })
    actionMap.clearBindingTransformers()

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "z", cmd: "submit" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("z")

    expect(calls).toEqual(["submit"])
  })

  test("binding expanders can use layer fields for optional emacs-style key strings", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerLayerFields({
      emacsStyle(value) {
        if (typeof value !== "boolean") {
          throw new Error('ActionMap layer field "emacsStyle" must be a boolean')
        }
      },
    })

    actionMap.appendBindingExpander(({ input, layer }) => {
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

    actionMap.registerToken({ name: "<c-x>", key: { name: "x", ctrl: true } })
    actionMap.registerToken({ name: "<c-s>", key: { name: "s", ctrl: true } })
    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "save-buffer",
        run() {
          calls.push("save")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      emacsStyle: true,
      bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("s", { ctrl: true })

    expect(calls).toEqual(["save"])

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
  })

  test("clearBindingExpanders allows replacing the expander chain", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    })
    actionMap.clearBindingExpanders()

    actionMap.appendBindingExpander(({ input }) => {
      if (!input.includes("|")) {
        return undefined
      }

      return input
        .split("|")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
    })

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "a,b", cmd: "comma-command" }],
    })
    actionMap.registerLayer({
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

  test("can dispose binding transformers to stop transforming future layer registrations", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const offTransformer = actionMap.appendBindingTransformer((binding, ctx) => {
      if (binding.blocked !== true) {
        return
      }

      ctx.skipOriginal()
    })

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", blocked: true, cmd: "blocked" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    offTransformer()

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "y", blocked: true, cmd: "active" }],
    })

    mockInput.pressKey("y")
    expect(calls).toEqual(["active"])
  })

  test("binding transformer ctx.parseKey normalizes object keys", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendBindingTransformer((binding, ctx) => {
      ctx.add({
        ...binding,
        sequence: [ctx.parseKey({ name: " RETURN " })],
      })
      ctx.skipOriginal()
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["submit"])
    expect(getActiveKey(actionMap, "return")?.display).toBe("enter")
    expect(getActiveKey(actionMap, "x")).toBeUndefined()
  })

  test("binding transformer ctx.parseKey uses the current parser and token configuration", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.clearBindingParsers()
    actionMap.appendBindingParser(({ input, index, tokens }) => {
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
    actionMap.appendBindingParser(defaultBindingParser)

    actionMap.clearBindingSyntax()
    actionMap.setBindingSyntax({
      normalizeTokenName(token) {
        const normalized = token.trim()
        if (!normalized) {
          throw new Error("Invalid action map token: token cannot be empty")
        }

        return normalized
      },
      parseObjectKey(key) {
        return defaultBindingSyntax.parseObjectKey(key)
      },
    })

    actionMap.appendBindingTransformer((binding, ctx) => {
      ctx.add({
        ...binding,
        sequence: [ctx.parseKey("[Leader]")],
      })
      ctx.skipOriginal()
    })

    actionMap.registerToken({ name: "[Leader]", key: { name: "x", ctrl: true } })
    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "z", cmd: "submit" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["submit"])
  })

  test("binding parser ctx.parseObjectKey normalizes object keys", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.prependBindingParser(({ input, index, parseObjectKey }) => {
      if (index !== 0 || input !== "@") {
        return undefined
      }

      return {
        parts: [parseObjectKey({ name: " RETURN " })],
        nextIndex: input.length,
      }
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "@", cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["submit"])
    expect(getActiveKey(actionMap, "return")?.display).toBe("enter")
  })

  test("binding parser ctx.parseObjectKey uses the current binding syntax", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.clearBindingSyntax()
    actionMap.setBindingSyntax({
      normalizeTokenName(token) {
        const normalized = token.trim().toLowerCase()
        if (!normalized) {
          throw new Error("Invalid action map token: token cannot be empty")
        }

        return normalized
      },
      parseObjectKey(key) {
        const parsed = defaultBindingSyntax.parseObjectKey(key)
        return {
          ...parsed,
          display: `custom:${parsed.display}`,
        }
      },
    })

    actionMap.prependBindingParser(({ input, index, parseObjectKey }) => {
      if (index !== 0 || input !== "@") {
        return undefined
      }

      return {
        parts: [parseObjectKey({ name: "x" })],
        nextIndex: input.length,
      }
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "@", cmd: "submit" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["submit"])
    expect(getActiveKey(actionMap, "x")?.display).toBe("custom:x")
  })

  test("skips bindings when a binding expander returns an empty expansion", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.appendBindingExpander(() => {
      return []
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['ActionMap binding expander must return at least one key sequence for "x"'])
    expect(getActiveKey(actionMap, "x")).toBeUndefined()
  })

  test("skips bindings when a binding parser does not advance the input", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.clearBindingParsers()
    actionMap.appendBindingParser(() => {
      return { parts: [], nextIndex: 0 }
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['ActionMap binding parser must advance the input for "x" at index 0'])
    expect(getActiveKey(actionMap, "x")).toBeUndefined()
  })

  test("supports release dispatch through registered fallback strokes", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendEventMatchResolver((event) => {
      if (event.name !== "x") {
        return undefined
      }

      return [getMatchKeyForEventName(event, "y")]
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "release-action",
        run() {
          calls.push("release")
        },
      },
    ] })

    actionMap.registerLayer({
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

  test("event match resolver ctx.matchKey normalizes object keys", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [ctx.matchKey({ name: " RETURN " })]
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "submit",
        run() {
          calls.push("submit")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "return", cmd: "submit" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["submit"])
  })

  test("event match resolver ctx.matchKey uses the current parser and token configuration", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.clearBindingParsers()
    actionMap.appendBindingParser(({ input, index, tokens }) => {
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
    actionMap.appendBindingParser(defaultBindingParser)

    actionMap.clearBindingSyntax()
    actionMap.setBindingSyntax({
      normalizeTokenName(token) {
        const normalized = token.trim()
        if (!normalized) {
          throw new Error("Invalid action map token: token cannot be empty")
        }

        return normalized
      },
      parseObjectKey(key) {
        return defaultBindingSyntax.parseObjectKey(key)
      },
    })

    actionMap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x" || !event.ctrl) {
        return undefined
      }

      return [ctx.matchKey("[Leader]")]
    })

    actionMap.registerToken({ name: "[Leader]", key: { name: "z" } })
    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "leader-fallback",
        run() {
          calls.push("leader")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "[Leader]", cmd: "leader-fallback" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["leader"])
  })

  test("supports hyper key bindings", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
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

    const actionMap = getActionMap(renderer)
    const calls: Array<{ capsLock: boolean; numLock: boolean }> = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "inspect-locks",
        run({ event }) {
          calls.push({
            capsLock: event.capsLock === true,
            numLock: event.numLock === true,
          })
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "a", cmd: "inspect-locks" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[97;193u"))

    expect(calls).toEqual([{ capsLock: true, numLock: true }])
  })

  test("matches a target layer by default with focus-within semantics", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const parent = createFocusableBox("parent")
    const child = createFocusableBox("child")
    parent.add(child)
    renderer.root.add(parent)

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "parent-action",
        run() {
          calls.push("parent")
        },
      },
    ] })

    actionMap.registerLayer({
      target: parent,
      bindings: [{ key: "x", cmd: "parent-action" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["parent"])
  })

  test("does not match focus-only layers for focused descendants", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const parent = createFocusableBox("focus-parent")
    const child = createFocusableBox("focus-child")
    parent.add(child)
    renderer.root.add(parent)

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "focus-only",
        run() {
          calls.push("focus-only")
        },
      },
    ] })

    actionMap.registerLayer({
      target: parent,
      scope: "focus",
      bindings: [{ key: "x", cmd: "focus-only" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })

  test("prefers local layers over global ones and supports fallthrough", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const target = createFocusableBox("target")
    renderer.root.add(target)

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "x", cmd: "global-action" },
        { key: "y", cmd: "global-action" },
      ],
    })

    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)
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

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "consume",
        run() {
          calls.push("action-map")
        },
      },
    ] })

    actionMap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "consume" }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["action-map"])
    expect(laterGlobalCount).toBe(0)
    expect(renderableCount).toBe(0)
  })

  test("preventDefault and fallthrough are orthogonal: two axes, four combinations", () => {
    // `preventDefault` controls whether the key leaves the action-map;
    // `fallthrough` controls whether dispatch continues inside it.
    const actionMap = getActionMap(renderer)
    const runs: Record<string, string[]> = { a: [], b: [], c: [], d: [] }
    const outsideSeen: Record<string, boolean> = { a: false, b: false, c: false, d: false }

    function register(keyName: "a" | "b" | "c" | "d", preventDefault: boolean, fallthrough: boolean): void {
      const bucket = runs[keyName]!
      actionMap.registerLayer({ scope: "global", commands: [
        {
          name: `primary-${keyName}`,
          run() {
            bucket.push("primary")
          },
        },
        {
          name: `followup-${keyName}`,
          run() {
            bucket.push("followup")
          },
        },
      ] })
      // Keep both bindings on the same `preventDefault` value so each case
      // varies only one axis.
      actionMap.registerLayer({
        scope: "global",
        bindings: [
          { key: keyName, cmd: `primary-${keyName}`, preventDefault, fallthrough },
          { key: keyName, cmd: `followup-${keyName}`, preventDefault },
        ],
      })
    }

    // This runs after action-map dispatch, so it only sees keys that were not
    // consumed.
    renderer.keyInput.on("keypress", (event) => {
      if (event.name in outsideSeen) {
        outsideSeen[event.name] = true
      }
    })

    register("a", true, false) // defaults: consumed, no fallthrough
    register("b", false, false) // not consumed, no fallthrough
    register("c", true, true) // consumed, fallthrough
    register("d", false, true) // not consumed, fallthrough

    mockInput.pressKey("a")
    mockInput.pressKey("b")
    mockInput.pressKey("c")
    mockInput.pressKey("d")

    expect(runs.a).toEqual(["primary"])
    expect(runs.b).toEqual(["primary"])
    expect(runs.c).toEqual(["primary", "followup"])
    expect(runs.d).toEqual(["primary", "followup"])

    expect(outsideSeen.a).toBe(false)
    expect(outsideSeen.b).toBe(true)
    expect(outsideSeen.c).toBe(false)
    expect(outsideSeen.d).toBe(true)
  })

  test("preventDefault false lets the focused renderable keep handling the key", () => {
    const actionMap = getActionMap(renderer)
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

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "passthrough",
        run() {
          calls.push("action-map")
        },
      },
    ] })

    actionMap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "passthrough", preventDefault: false }],
    })

    target.focus()
    mockInput.pressKey("x")

    expect(calls).toEqual(["action-map"])
    expect(laterGlobalCount).toBe(1)
    expect(renderableCount).toBe(1)
  })

  test("supports object shorthand bindings", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "shorthand",
        run() {
          calls.push("shorthand")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: {
        x: "shorthand",
      },
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["shorthand"])
  })

  test("allows duplicate command names across layers and dedupes reachable commands by name", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)
    const calls: string[] = []

    actionMap.registerLayer({
      scope: "global",
      commands: [{ name: "dup", run: () => calls.push("first") }],
    })

    actionMap.registerLayer({
      scope: "global",
      commands: [{ name: "dup", run: () => calls.push("second") }],
    })

    expect(errors).toEqual([])
    expect(actionMap.getCommands().map((command) => command.name)).toEqual(["dup"])
    expect(actionMap.getCommands({ visibility: "active" }).map((command) => command.name)).toEqual(["dup", "dup"])
    expect(actionMap.getCommands({ visibility: "registered" }).map((command) => command.name)).toEqual(["dup", "dup"])
    expect(actionMap.runCommand("dup")).toEqual({ ok: true })
    expect(calls).toEqual(["second"])
  })

  test("can dispose command resolvers and refresh existing bindings", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "external-run" }],
    })

    expect(getActiveKey(actionMap, "x")?.command).toBeUndefined()

    const offResolver = actionMap.appendCommandResolver((command) => {
      if (command !== "external-run") {
        return undefined
      }

      return {
        run() {
          calls.push("external")
        },
      }
    })

    expect(getActiveKey(actionMap, "x")?.command).toBe("external-run")

    mockInput.pressKey("x")
    expect(calls).toEqual(["external"])

    offResolver()

    expect(getActiveKey(actionMap, "x")?.command).toBeUndefined()

    mockInput.pressKey("x")
    expect(calls).toEqual(["external"])
  })

  test("supports typed binding fields through key intercepts", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    actionMap.intercept("key", ({ event, setData }) => {
      if (event.name === "x") {
        setData("vim.mode", "normal")
      }
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "typed-field",
        run() {
          calls.push("field")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", mode: "normal", cmd: "typed-field" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["field"])
    expect(actionMap.getData("vim.mode")).toBe("normal")
  })

  test("supports binding metadata attributes through typed fields", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
      group(value, ctx) {
        ctx.attr("group", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "save-file",
        run() {},
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "Save file", group: "File" }],
    })

    const activeKey = getActiveKey(actionMap, "x", { includeBindings: true })
    const activeBinding = activeKey?.bindings?.[0]
    expect(activeKey?.bindings).toHaveLength(1)
    expect(activeBinding?.attrs).toEqual({ desc: "Save file", group: "File" })
    expect(activeBinding?.command).toBe("save-file")
    expect(activeBinding?.commandAttrs).toBeUndefined()
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.commandAttrs).toBeUndefined()
  })

  test("typed binding fields can emit both requirements and attributes", () => {
    const actionMap = getActionMap(renderer)
    const seen: string[] = []

    actionMap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
        ctx.attr("mode", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "record-mode",
        run(ctx) {
          seen.push(String(ctx.data["vim.mode"]))
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", mode: "normal", cmd: "record-mode" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])

    actionMap.setData("vim.mode", "normal")

    const activeKey = getActiveKey(actionMap, "x", { includeBindings: true })
    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ mode: "normal" })

    mockInput.pressKey("x")

    expect(seen).toEqual(["normal"])
  })

  test("typed binding fields can emit runtime matchers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    let enabled = false

    actionMap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap binding field "active" must be true')
        }

        ctx.match(() => enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "runtime-binding",
        run() {
          calls.push("binding")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])

    enabled = true

    expect(getActiveKeyNames(actionMap)).toEqual(["x"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["binding"])

    enabled = false

    expect(getActiveKeyNames(actionMap)).toEqual([])
  })

  test("includeMetadata re-evaluates unkeyed binding matchers on each read", () => {
    const actionMap = getActionMap(renderer)
    let enabled = false

    actionMap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap binding field "active" must be true')
        }

        ctx.match(() => enabled)
        ctx.attr("label", "Runtime binding")
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "runtime-binding", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(getActiveKey(actionMap, "x", { includeMetadata: true })?.bindingAttrs).toBeUndefined()
    expect(getActiveKey(actionMap, "x", { includeMetadata: true })?.commandAttrs).toBeUndefined()

    enabled = true

    expect(getActiveKey(actionMap, "x", { includeMetadata: true })?.bindingAttrs).toEqual({ label: "Runtime binding" })
    expect(getActiveKey(actionMap, "x", { includeMetadata: true })?.commandAttrs).toBeUndefined()
  })

  test("typed binding field matchers clear pending sequences when they stop matching", () => {
    const actionMap = getActionMap(renderer)
    let enabled = true

    actionMap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap binding field "active" must be true')
        }

        ctx.match(() => enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", active: true, cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(actionMap.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(actionMap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(actionMap)).toEqual([])
  })

  test("treats thrown binding runtime matchers as non-matching", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap binding field "active" must be true')
        }

        ctx.match(() => {
          throw new Error("boom")
        })
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "runtime-binding",
        run() {
          calls.push("binding")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(() => actionMap.getActiveKeys()).not.toThrow()
    expect(getActiveKeyNames(actionMap)).toEqual([])

    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })

  test("typed binding field matchers can use reactive matchers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    const enabled = createReactiveBoolean(false)
    let evaluations = 0

    actionMap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap binding field "active" must be true')
        }

        ctx.match({
          get() {
            evaluations += 1
            return enabled.get()
          },
          subscribe(onChange) {
            return enabled.subscribe(onChange)
          },
        })
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "runtime-binding",
        run() {
          calls.push("binding")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    // First read warms the cache.
    expect(getActiveKeyNames(actionMap)).toEqual([])
    expect(evaluations).toBe(1)

    expect(getActiveKeyNames(actionMap)).toEqual([])
    expect(evaluations).toBe(1)

    // Unrelated `setData` invalidation should not touch a purely reactive matcher.
    actionMap.setData("unrelated", true)

    expect(getActiveKeyNames(actionMap)).toEqual([])
    expect(evaluations).toBe(1)

    enabled.set(true)

    expect(getActiveKeyNames(actionMap)).toEqual(["x"])
    expect(evaluations).toBe(2)

    mockInput.pressKey("x")

    expect(calls).toEqual(["binding"])

    enabled.set(false)

    expect(getActiveKeyNames(actionMap)).toEqual([])
    expect(evaluations).toBe(3)
  })

  test("reactive matchers: subscribe at layer register, dispose at unregister", () => {
    const actionMap = getActionMap(renderer)
    const enabled = createReactiveBoolean(true)

    actionMap.registerLayerFields({
      active(_value, ctx) {
        ctx.match(enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })

    expect(enabled.subscribeCalls).toBe(0)
    expect(enabled.subscriptions).toBe(0)

    const off = actionMap.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(enabled.subscribeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(1)
    expect(enabled.disposeCalls).toBe(0)

    off()

    expect(enabled.disposeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(0)
  })

  test("reactive matchers: dispose on renderer destroy", () => {
    const actionMap = getActionMap(renderer)
    const enabled = createReactiveBoolean(true)

    actionMap.registerLayerFields({
      active(_value, ctx) {
        ctx.match(enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(enabled.subscriptions).toBe(1)

    renderer.destroy()

    expect(enabled.disposeCalls).toBe(1)
    expect(enabled.subscriptions).toBe(0)
  })

  test("reactive matchers: only invalidate their own target, not other layers", () => {
    const actionMap = getActionMap(renderer)
    const firstEnabled = createReactiveBoolean(false)
    const secondEnabled = createReactiveBoolean(false)

    let firstEvals = 0
    let secondEvals = 0

    actionMap.registerLayerFields({
      first(_value, ctx) {
        ctx.match({
          get() {
            firstEvals += 1
            return firstEnabled.get()
          },
          subscribe: firstEnabled.subscribe,
        })
      },
      second(_value, ctx) {
        ctx.match({
          get() {
            secondEvals += 1
            return secondEnabled.get()
          },
          subscribe: secondEnabled.subscribe,
        })
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      first: true,
      bindings: [{ key: "a", cmd: "noop" }],
    })
    actionMap.registerLayer({
      scope: "global",
      second: true,
      bindings: [{ key: "b", cmd: "noop" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])
    expect(firstEvals).toBe(1)
    expect(secondEvals).toBe(1)

    firstEnabled.set(true)
    expect(getActiveKeyNames(actionMap)).toEqual(["a"])
    expect(firstEvals).toBe(2)
    expect(secondEvals).toBe(1)

    secondEnabled.set(true)
    expect(getActiveKeyNames(actionMap)).toEqual(["a", "b"])
    expect(firstEvals).toBe(2)
    expect(secondEvals).toBe(2)
  })

  test("reactive matchers: errors in subscribe are routed to error channel and registration continues", () => {
    const actionMap = getActionMap(renderer)
    const errors: string[] = []
    const causes: unknown[] = []
    actionMap.on("error", (event) => {
      errors.push(event.message)
      causes.push(event.cause)
    })

    const badMatcher: ReactiveMatcher = {
      get: () => true,
      subscribe() {
        throw new Error("subscribe boom")
      },
    }

    actionMap.registerLayerFields({
      active(_value, ctx) {
        ctx.match(badMatcher)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        active: true,
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe("subscribe boom")
    expect(causes[0]).toBeInstanceOf(Error)
    expect(getActiveKeyNames(actionMap)).toEqual(["x"])
  })

  test("reactive matchers: errors in dispose are routed to error channel", () => {
    const actionMap = getActionMap(renderer)
    const errors: string[] = []
    actionMap.on("error", (event) => {
      errors.push(event.message)
    })

    const badMatcher: ReactiveMatcher = {
      get: () => true,
      subscribe() {
        return () => {
          throw new Error("dispose boom")
        }
      },
    }

    actionMap.registerLayerFields({
      active(_value, ctx) {
        ctx.match(badMatcher)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })
    const off = actionMap.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(() => off()).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe("dispose boom")
  })

  test("reactive matchers: errors in get are routed to error channel and evaluate to false", () => {
    const actionMap = getActionMap(renderer)
    const errors: { message: string; cause?: unknown }[] = []
    actionMap.on("error", (event) => {
      errors.push({ message: event.message, cause: event.cause })
    })

    const cause = new Error("get boom")
    const badMatcher: ReactiveMatcher = {
      get() {
        throw cause
      },
      subscribe: () => () => {},
    }

    actionMap.registerLayerFields({
      active(_value, ctx) {
        ctx.match(badMatcher)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])
    expect(errors.some((e) => e.message.includes("Error evaluating runtime matcher") && e.cause === cause)).toBe(true)
  })

  test("reactive matchers: coexist with require()-based data dependencies on the same layer", () => {
    const actionMap = getActionMap(renderer)
    const enabled = createReactiveBoolean(false)

    actionMap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
      active(_value, ctx) {
        ctx.match(enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      mode: "normal",
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])

    actionMap.setData("vim.mode", "normal")
    expect(getActiveKeyNames(actionMap)).toEqual([])

    actionMap.setData("vim.mode", undefined)
    enabled.set(true)
    expect(getActiveKeyNames(actionMap)).toEqual([])

    actionMap.setData("vim.mode", "normal")
    expect(getActiveKeyNames(actionMap)).toEqual(["x"])

    enabled.set(false)
    expect(getActiveKeyNames(actionMap)).toEqual([])
  })

  test("reactive matchers: raw callback matchers still work (non-cacheable path)", () => {
    const actionMap = getActionMap(renderer)
    let enabled = false
    let evaluations = 0

    actionMap.registerLayerFields({
      active(_value, ctx) {
        ctx.match(() => {
          evaluations += 1
          return enabled
        })
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])
    expect(evaluations).toBe(1)

    expect(getActiveKeyNames(actionMap)).toEqual([])
    expect(evaluations).toBe(2)

    enabled = true
    expect(getActiveKeyNames(actionMap)).toEqual(["x"])
    expect(evaluations).toBe(3)
  })

  test("reactive matchers: rejects non-function non-reactive matcher values", () => {
    const actionMap = getActionMap(renderer)
    const errors: string[] = []
    actionMap.on("error", (event) => {
      errors.push(event.message)
    })

    actionMap.registerLayerFields({
      active(_value, ctx) {
        ctx.match(42 as unknown as () => boolean)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        active: true,
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors.some((m) => m.includes("expected a function or a reactive matcher"))).toBe(true)
  })

  test("reactive matchers on binding fields: re-subscribe after token-driven recompile", () => {
    const actionMap = getActionMap(renderer)
    const enabled = createReactiveBoolean(true)

    actionMap.registerBindingFields({
      active(_value, ctx) {
        ctx.match(enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })

    const offToken = actionMap.registerToken({ name: "<leader>", key: { name: "x", ctrl: true } })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", active: true, cmd: "noop" }],
    })

    expect(enabled.subscriptions).toBe(1)
    const subscribesBefore = enabled.subscribeCalls
    const disposesBefore = enabled.disposeCalls

    // Token changes recompile bindings, so binding-level matchers must
    // re-subscribe.
    offToken()

    expect(enabled.disposeCalls).toBe(disposesBefore + 1)
    expect(enabled.subscribeCalls).toBe(subscribesBefore + 1)
    expect(enabled.subscriptions).toBe(1)
  })

  test("supports typed layer fields for local scopes", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "local-mode",
        run() {
          calls.push("local")
        },
      },
    ] })

    const target = createFocusableBox("layer-field-target")
    renderer.root.add(target)

    actionMap.registerLayer({
      target,
      mode: "normal",
      bindings: [{ key: "x", cmd: "local-mode" }],
    })

    target.focus()

    expect(getActiveKeyNames(actionMap)).toEqual([])

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    actionMap.setData("vim.mode", "normal")

    expect(getActiveKeyNames(actionMap)).toEqual(["x"])

    mockInput.pressKey("x")
    expect(calls).toEqual(["local"])
  })

  test("typed layer fields can emit runtime matchers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []
    let enabled = false

    actionMap.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap layer field "active" must be true')
        }

        ctx.match(() => enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "runtime-layer",
        run() {
          calls.push("layer")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "x", cmd: "runtime-layer" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])

    enabled = true

    expect(getActiveKeyNames(actionMap)).toEqual(["x"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["layer"])

    enabled = false

    expect(getActiveKeyNames(actionMap)).toEqual([])
  })

  test("typed layer field matchers clear pending sequences when they stop matching", () => {
    const actionMap = getActionMap(renderer)
    let enabled = true

    actionMap.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap layer field "active" must be true')
        }

        ctx.match(() => enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(actionMap.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(actionMap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(actionMap)).toEqual([])
  })

  test("typed layer field matchers clear pending sequences when reactive matchers flip off", () => {
    const actionMap = getActionMap(renderer)
    const enabled = createReactiveBoolean(true)

    actionMap.registerLayerFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap layer field "active" must be true')
        }

        ctx.match(enabled)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      active: true,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(actionMap.getPendingSequence()).toHaveLength(1)

    enabled.set(false)

    expect(actionMap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(actionMap)).toEqual([])
  })

  test("layer and binding requirements compose", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    actionMap.registerBindingFields({
      state(value, ctx) {
        ctx.require("vim.state", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "composed",
        run() {
          calls.push("hit")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      mode: "normal",
      bindings: [{ key: "x", state: "idle", cmd: "composed" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])

    actionMap.setData("vim.mode", "normal")
    expect(getActiveKeyNames(actionMap)).toEqual([])

    actionMap.setData("vim.state", "idle")
    expect(getActiveKeyNames(actionMap)).toEqual(["x"])

    mockInput.pressKey("x")
    expect(calls).toEqual(["hit"])

    actionMap.setData("vim.mode", "visual")
    expect(getActiveKeyNames(actionMap)).toEqual([])
  })

  test("supports command metadata attributes in active keys and command contexts", () => {
    const actionMap = getActionMap(renderer)
    const seen: Record<string, unknown>[] = []

    actionMap.registerCommandFields({
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

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "save-file",
        desc: "Save the current file",
        title: "Save File",
        category: "File",
        run(ctx) {
          seen.push({ ...(ctx.command?.attrs ?? {}) })
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    const attrs = {
      desc: "Save the current file",
      title: "Save File",
      category: "File",
    }

    const activeKey = getActiveKey(actionMap, "x", { includeBindings: true, includeMetadata: true })
    expect(activeKey?.bindings?.[0]?.command).toBe("save-file")
    expect(activeKey?.bindings?.[0]?.commandAttrs).toEqual(attrs)
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.commandAttrs).toEqual(attrs)

    mockInput.pressKey("x")

    expect(seen).toEqual([attrs])
  })

  test("getCommands searches names by default and returns raw fields plus compiled attrs", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerCommandFields({
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    expect(actionMap.getCommands({ search: "save" }).map((command) => command.name)).toEqual(["save-current"])
    expect(actionMap.getCommands({ search: "write" })).toEqual([])
    expect(actionMap.getCommands({ search: "write", searchIn: ["title"] }).map((command) => command.name)).toEqual([
      "save-current",
    ])
    expect(actionMap.getCommands({ search: "write", searchIn: ["label"] }).map((command) => command.name)).toEqual([
      "save-current",
    ])
    expect(getCommand(actionMap, "save-current")).toEqual({
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
    const actionMap = getActionMap(renderer)

    actionMap.registerCommandFields({
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    const offCommands = actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    expect(actionMap.getCommands({ namespace: "excommands" }).map((command) => command.name)).toEqual([
      "save-current",
      "session-reset",
    ])
    expect(actionMap.getCommands({ namespace: ["palette", "missing"] }).map((command) => command.name)).toEqual([
      "palette-help",
    ])
    expect(
      actionMap
        .getCommands({ namespace: "excommands", search: "reset", searchIn: ["title"] })
        .map((command) => command.name),
    ).toEqual(["session-reset"])
    expect(actionMap.getCommands({ filter: { namespace: "excommands" } }).map((command) => command.name)).toEqual([
      "save-current",
      "session-reset",
    ])
    expect(actionMap.getCommands({ filter: { tags: "file" } }).map((command) => command.name)).toEqual(["save-current"])
    expect(actionMap.getCommands({ filter: { label: "Reset Counters" } }).map((command) => command.name)).toEqual([
      "session-reset",
    ])
    expect(
      actionMap
        .getCommands({
          filter: {
            usage(value: unknown, command: CommandRecord) {
              return typeof value === "string" && value.includes("<file>") && command.fields.namespace === "excommands"
            },
          },
        })
        .map((command) => command.name),
    ).toEqual(["save-current"])
    expect(
      actionMap
        .getCommands({
          namespace: "excommands",
          filter: {
            usage(value: unknown) {
              return typeof value === "string" && value.includes("<file>")
            },
          },
        })
        .map((command) => command.name),
    ).toEqual(["save-current"])
    expect(
      actionMap.getCommands({ filter: (command) => command.name === "palette-help" }).map((command) => command.name),
    ).toEqual(["palette-help"])

    offCommands()

    expect(actionMap.getCommands()).toEqual([])
  })

  test("getCommands defaults to reachable commands and supports active and registered visibility", () => {
    const actionMap = getActionMap(renderer)

    const target = createFocusableBox("command-visibility-target")
    renderer.root.add(target)

    actionMap.registerLayer({
      scope: "global",
      commands: [
        { name: "save", title: "Global Save", run() {} },
        { name: "quit", title: "Quit", run() {} },
      ],
    })
    actionMap.registerLayer({
      target,
      commands: [{ name: "save", title: "Local Save", run() {} }],
    })

    expect(actionMap.getCommands().map((command) => command.name)).toEqual(["save", "quit"])
    expect(actionMap.getCommands().map((command) => command.fields.title)).toEqual(["Global Save", "Quit"])
    expect(actionMap.getCommands({ visibility: "active" }).map((command) => command.fields.title)).toEqual([
      "Global Save",
      "Quit",
    ])
    expect(actionMap.getCommands({ visibility: "registered" }).map((command) => command.fields.title)).toEqual([
      "Global Save",
      "Quit",
      "Local Save",
    ])

    target.focus()

    expect(actionMap.getCommands().map((command) => command.fields.title)).toEqual(["Local Save", "Quit"])
    expect(actionMap.getCommands({ visibility: "active" }).map((command) => command.fields.title)).toEqual([
      "Local Save",
      "Global Save",
      "Quit",
    ])
    expect(actionMap.getCommands({ visibility: "registered" }).map((command) => command.fields.title)).toEqual([
      "Global Save",
      "Quit",
      "Local Save",
    ])
  })

  test("getCommands treats thrown filter predicates as errors and returns no matches", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerLayer({ scope: "global", commands: [
      { name: "save-current", usage: ":write <file>", run() {} },
      { name: "palette-help", usage: ":help", run() {} },
    ] })

    let queryResult: ReturnType<ActionMap["getCommands"]> = []

    expect(() => {
      queryResult = actionMap.getCommands({
        filter(command) {
          throw new Error(`query ${command.name}`)
        },
      })
    }).not.toThrow()

    expect(queryResult).toEqual([])
    expect(errors).toEqual(["[ActionMap] Error in command query filter:", "[ActionMap] Error in command query filter:"])

    errors.length = 0

    expect(() => {
      queryResult = actionMap.getCommands({
        filter: {
          usage() {
            throw new Error("usage boom")
          },
        },
      })
    }).not.toThrow()

    expect(queryResult).toEqual([])
    expect(errors).toEqual(["[ActionMap] Error in command query filter:", "[ActionMap] Error in command query filter:"])
  })

  test("getCommands returns immutable metadata records across repeated reads", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "save-current",
        tags: ["file", "write"],
        run() {},
      },
    ] })

    const first = getCommand(actionMap, "save-current")
    expect(first).toBeDefined()
    expect(Object.isFrozen(first!.fields)).toBe(true)
    expect(Object.isFrozen(first!.fields.tags as object)).toBe(true)

    expect(() => {
      ;(first!.fields.tags as string[]).push("mutated")
    }).toThrow()

    const second = getCommand(actionMap, "save-current")
    expect(second).toBe(first)
    expect(second).toEqual({
      name: "save-current",
      fields: {
        tags: ["file", "write"],
      },
    })
  })

  test("getCommands clones plain metadata deeply but preserves opaque values by reference", () => {
    const actionMap = getActionMap(renderer)
    const opaque = new Map([["recent", 1]])
    const helper = () => "ok"
    const payload = {
      nested: { title: "Write File" },
      tags: ["file", { kind: "write" }],
      opaque,
      helper,
    }

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "save-current",
        payload,
        run() {},
      },
    ] })

    payload.nested.title = "Mutated"
    ;(payload.tags[1] as { kind: string }).kind = "mutated"

    const command = getCommand(actionMap, "save-current")
    const storedPayload = command?.fields.payload as {
      nested: { title: string }
      tags: [string, { kind: string }]
      opaque: Map<string, number>
      helper: () => string
    }

    expect(storedPayload).toBeDefined()
    expect(storedPayload).not.toBe(payload)
    expect(storedPayload.nested).not.toBe(payload.nested)
    expect(storedPayload.tags).not.toBe(payload.tags)
    expect(storedPayload.tags[1]).not.toBe(payload.tags[1])
    expect(storedPayload.nested.title).toBe("Write File")
    expect(storedPayload.tags[1]).toEqual({ kind: "write" })
    expect(storedPayload.opaque).toBe(opaque)
    expect(storedPayload.helper).toBe(helper)
    expect(Object.isFrozen(storedPayload)).toBe(true)
    expect(Object.isFrozen(storedPayload.nested)).toBe(true)
    expect(Object.isFrozen(storedPayload.tags)).toBe(true)
    expect(Object.isFrozen(storedPayload.tags[1])).toBe(true)
  })

  test("keeps active key projections isolated across repeated reads", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
      group(value, ctx) {
        ctx.attr("group", value)
      },
    })
    actionMap.registerCommandFields({
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

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "save-file",
        desc: "Save the current file",
        title: "Save File",
        category: "File",
        run() {},
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const plain = getActiveKey(actionMap, "x")
    const metadataOnly = getActiveKey(actionMap, "x", { includeMetadata: true })
    const withBindings = getActiveKey(actionMap, "x", { includeBindings: true })
    const withBindingsAndMetadata = getActiveKey(actionMap, "x", { includeBindings: true, includeMetadata: true })
    const plainAgain = getActiveKey(actionMap, "x")

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
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "delete-line",
        run() {
          calls.push("delete-line")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual(["d"])

    mockInput.pressKey("d")

    expect(actionMap.getPendingSequence()).toEqual([
      {
        stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false },
        display: "d",
        matchKey: "d:0:0:0:0:0",
      },
    ])
    expect(getActiveKeyNames(actionMap)).toEqual(["d"])
    expect(getActiveKey(actionMap, "d")?.command).toBe("delete-line")
    expect(getActiveKey(actionMap, "d")?.display).toBe("d")

    mockInput.pressKey("d")

    expect(calls).toEqual(["delete-line"])
    expect(actionMap.getPendingSequence()).toEqual([])
  })

  test("hasPendingSequence reflects pending lifecycle", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    expect(actionMap.hasPendingSequence()).toBe(false)

    mockInput.pressKey("d")
    expect(actionMap.hasPendingSequence()).toBe(true)

    actionMap.popPendingSequence()
    expect(actionMap.hasPendingSequence()).toBe(false)

    mockInput.pressKey("d")
    expect(actionMap.hasPendingSequence()).toBe(true)

    actionMap.clearPendingSequence()
    expect(actionMap.hasPendingSequence()).toBe(false)
  })

  test("key intercepts can be gated by hasPendingSequence", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "delete-line",
        run() {
          calls.push("delete")
        },
      },
    ] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    const off = actionMap.intercept("key", ({ event }) => {
      if (!actionMap.hasPendingSequence()) {
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
    const actionMap = getActionMap(renderer)
    const changes: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "delete-ca",
        run() {},
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    actionMap.on("pendingSequence", (sequence) => {
      changes.push(stringifyKeySequence(sequence, { preferDisplay: true }))
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    actionMap.popPendingSequence()
    actionMap.clearPendingSequence()

    expect(changes).toEqual(["d", "dc", "d", ""])
  })

  test("notifies state changes with the current pending sequence and active keys", () => {
    const actionMap = getActionMap(renderer)
    const snapshots: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "delete-ca",
        run() {},
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    actionMap.on("state", () => {
      const pending = stringifyKeySequence(actionMap.getPendingSequence(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(actionMap).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")
    actionMap.popPendingSequence()
    actionMap.clearPendingSequence()

    expect(snapshots).toEqual(["d:c", "dc:a", "d:c", "<root>:d"])
  })

  test("coalesces state changes when runtime data clears a pending sequence", () => {
    const actionMap = getActionMap(renderer)
    const snapshots: string[] = []

    actionMap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      mode: "normal",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    actionMap.setData("vim.mode", "normal")
    mockInput.pressKey("d")

    actionMap.on("state", () => {
      const pending = stringifyKeySequence(actionMap.getPendingSequence(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(actionMap).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    actionMap.setData("vim.mode", "visual")

    expect(snapshots).toEqual(["<root>:<none>"])
    expect(actionMap.getPendingSequence()).toEqual([])
  })

  test("notifies state changes when focus changes active layers and direct blur clears focus", () => {
    const actionMap = getActionMap(renderer)
    const target = createFocusableBox("state-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "local", run() {} }] })
    actionMap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    actionMap.on("state", () => {
      snapshots.push(getActiveKeyNames(actionMap).join(",") || "<none>")
    })

    target.focus()
    target.blur()

    expect(snapshots).toEqual(["x", "<none>"])
  })

  test("coalesces state changes when blur clears a pending sequence", () => {
    const actionMap = getActionMap(renderer)
    const target = createFocusableBox("pending-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      target,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    target.focus()
    mockInput.pressKey("d")

    actionMap.on("state", () => {
      const pending = stringifyKeySequence(actionMap.getPendingSequence(), { preferDisplay: true }) || "<root>"
      const active = getActiveKeyNames(actionMap).join(",") || "<none>"
      snapshots.push(`${pending}:${active}`)
    })

    target.blur()

    expect(snapshots).toEqual(["<root>:<none>"])
    expect(actionMap.getPendingSequence()).toEqual([])
  })

  test("clears global pending sequences when focus changes to another renderable", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const first = createFocusableBox("global-pending-first")
    const second = createFocusableBox("global-pending-second")
    renderer.root.add(first)
    renderer.root.add(second)

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "global-delete" }],
    })
    actionMap.registerLayer({
      target: second,
      bindings: [{ key: "d", cmd: "local-delete" }],
    })

    first.focus()
    mockInput.pressKey("d")

    expect(actionMap.getPendingSequence()).toHaveLength(1)

    second.focus()

    expect(actionMap.getPendingSequence()).toEqual([])

    mockInput.pressKey("d")

    expect(calls).toEqual(["local"])
  })

  test("clears global pending sequences when direct blur clears focus", () => {
    const actionMap = getActionMap(renderer)
    const target = createFocusableBox("global-pending-blur")

    renderer.root.add(target)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "global-delete", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "global-delete" }],
    })

    target.focus()
    mockInput.pressKey("d")

    expect(actionMap.getPendingSequence()).toHaveLength(1)

    target.blur()

    expect(actionMap.getPendingSequence()).toEqual([])
  })

  test("can unsubscribe state listeners", () => {
    const actionMap = getActionMap(renderer)
    const target = createFocusableBox("unsubscribe-target")
    const snapshots: string[] = []

    renderer.root.add(target)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "local", run() {} }] })
    actionMap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    const off = actionMap.on("state", () => {
      snapshots.push(getActiveKeyNames(actionMap).join(",") || "<none>")
    })

    off()
    target.focus()

    expect(snapshots).toEqual([])
  })

  test("uses a stable state listener snapshot when listeners unsubscribe mid-notification", () => {
    const actionMap = getActionMap(renderer)
    const target = createFocusableBox("state-snapshot-target")
    const calls: string[] = []

    renderer.root.add(target)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "local", run() {} }] })
    actionMap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    let offSecond!: () => void

    actionMap.on("state", () => {
      calls.push(`first:${getActiveKeyNames(actionMap).join(",") || "<none>"}`)
      offSecond()
    })

    offSecond = actionMap.on("state", () => {
      calls.push(`second:${getActiveKeyNames(actionMap).join(",") || "<none>"}`)
    })

    target.focus()
    target.blur()

    expect(calls).toEqual(["first:x", "second:x", "first:<none>"])
  })

  test("supports token aliases inside longer sequences", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerToken({
      name: "<leader>",
      key: { name: "x", ctrl: true },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "go-definition",
        run() {
          calls.push("go-definition")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>gd", cmd: "go-definition" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(getActiveKeyNames(actionMap)).toEqual(["g"])
    expect(getActiveKeyDisplay(actionMap, "g")?.command).toBeUndefined()
    expect(actionMap.getPendingSequence()).toEqual([
      {
        stroke: { name: "x", ctrl: true, shift: false, meta: false, super: false },
        display: "<leader>",
        matchKey: "x:1:0:0:0:0",
      },
    ])
    expect(getActiveKey(actionMap, "g")?.command).toBeUndefined()

    mockInput.pressKey("g")

    expect(getActiveKeyNames(actionMap)).toEqual(["d"])
    expect(stringifyKeySequence(actionMap.getPendingSequence(), { preferDisplay: true })).toBe("<leader>g")
    expect(getActiveKey(actionMap, "d")?.command).toBe("go-definition")

    mockInput.pressKey("d")

    expect(calls).toEqual(["go-definition"])
  })

  test("uses preserved display for unambiguous active token prefixes", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerToken({
      name: "<leader>",
      key: { name: "x", ctrl: true },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      { name: "save", run() {} },
      { name: "help", run() {} },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "<leader>s", cmd: "save" },
        { key: "<leader>h", cmd: "help" },
      ],
    })

    expect(getActiveKeyDisplay(actionMap, "<leader>")?.command).toBeUndefined()
    expect(stringifyKeyStroke(getActiveKeyDisplay(actionMap, "<leader>")!, { preferDisplay: true })).toBe("<leader>")
  })

  test("supports branching sequences", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "da", cmd: "delete-a" },
        { key: "db", cmd: "delete-b" },
        { key: "dca", cmd: "delete-ca" },
        { key: "dcb", cmd: "delete-cb" },
      ],
    })

    mockInput.pressKey("d")
    expect(getActiveKeyNames(actionMap)).toEqual(["a", "b", "c"])

    mockInput.pressKey("c")
    expect(getActiveKeyNames(actionMap)).toEqual(["a", "b"])

    mockInput.pressKey("b")
    expect(calls).toEqual(["dcb"])
    expect(actionMap.getPendingSequence()).toEqual([])
  })

  test("keeps pending sequences local to the layer that captured them", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const target = createFocusableBox("sequence-target")
    renderer.root.add(target)

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "da", cmd: "global-delete" }],
    })

    actionMap.registerLayer({
      target,
      bindings: [{ key: "dd", cmd: "local-delete" }],
    })

    target.focus()
    mockInput.pressKey("d")

    expect(getActiveKeyNames(actionMap)).toEqual(["d"])

    mockInput.pressKey("d")

    expect(calls).toEqual(["local"])
  })

  test("supports addon-style backspace editing for pending sequences", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "delete-ca",
        run() {
          calls.push("delete-ca")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    actionMap.intercept("key", ({ event, consume }) => {
      if (event.name !== "backspace") {
        return
      }

      if (!actionMap.popPendingSequence()) {
        return
      }

      consume()
    })

    mockInput.pressKey("d")
    mockInput.pressKey("c")

    expect(actionMap.getPendingSequence()).toEqual([
      { stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false }, display: "d", matchKey: "d:0:0:0:0:0" },
      { stroke: { name: "c", ctrl: false, shift: false, meta: false, super: false }, display: "c", matchKey: "c:0:0:0:0:0" },
    ])

    mockInput.pressBackspace()

    expect(actionMap.getPendingSequence()).toEqual([
      { stroke: { name: "d", ctrl: false, shift: false, meta: false, super: false }, display: "d", matchKey: "d:0:0:0:0:0" },
    ])
    expect(getActiveKeyNames(actionMap)).toEqual(["c"])

    mockInput.pressKey("c")
    mockInput.pressKey("a")

    expect(calls).toEqual(["delete-ca"])
  })

  test("clears pending sequences on invalid continuation", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")
    expect(actionMap.getPendingSequence()).toHaveLength(1)

    mockInput.pressKey("x")

    expect(actionMap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(actionMap)).toEqual(["d"])
  })

  test("getActiveKeys respects runtime requirements", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      { name: "normal-delete", run() {} },
      { name: "visual-delete", run() {} },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "dd", mode: "normal", cmd: "normal-delete" },
        { key: "vv", mode: "visual", cmd: "visual-delete" },
      ],
    })

    expect(getActiveKeyNames(actionMap)).toEqual([])

    actionMap.setData("vim.mode", "normal")
    expect(getActiveKeyNames(actionMap)).toEqual(["d"])

    actionMap.setData("vim.mode", "visual")
    expect(getActiveKeyNames(actionMap)).toEqual(["v"])
  })

  test("skips bindings with conflicting requirements from typed fields", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
      state(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "x", mode: "normal", state: "visual", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Conflicting action map requirement for "vim.mode" from field state'])
    expect(getActiveKey(actionMap, "x")).toBeUndefined()
  })

  test("skips layers with conflicting requirements from typed layer fields", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
      state(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        mode: "normal",
        state: "visual",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Conflicting action map requirement for "vim.mode" from field state'])
    expect(getActiveKey(actionMap, "x")).toBeUndefined()
  })

  test("skips bindings with conflicting attributes from typed binding fields", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("label", value)
      },
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "x", desc: "Delete line", title: "Delete", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Conflicting action map attribute for "label" from field title'])
    expect(getActiveKey(actionMap, "x")).toBeUndefined()
  })

  test("ignores unknown binding fields", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "noop",
        run() {
          calls.push("noop")
        },
      },
    ] })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "x", mode: "normal", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKey(actionMap, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(calls).toEqual(["noop"])
  })

  test("ignores unknown layer fields", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "noop",
        run() {
          calls.push("noop")
        },
      },
    ] })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKey(actionMap, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(calls).toEqual(["noop"])
  })

  test("stores raw command fields without requiring command field compilers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    expect(() => {
      actionMap.registerLayer({ scope: "global", commands: [
        {
          name: "save-file",
          desc: "Save the current file",
          usage: ":write <file>",
          tags: ["file", "write"],
          run() {
            calls.push("save-file")
          },
        },
      ] })
    }).not.toThrow()

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    expect(getCommand(actionMap, "save-file")).toEqual({
      name: "save-file",
      fields: {
        desc: "Save the current file",
        usage: ":write <file>",
        tags: ["file", "write"],
      },
    })

    expect(getActiveKey(actionMap, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(calls).toEqual(["save-file"])
  })

  test("emits warnings only for unknown binding and layer fields", () => {
    const actionMap = getActionMap(renderer)
    const { warnings } = captureDiagnostics(actionMap)

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      mode: "normal",
      bindings: [
        { key: "x", when: "normal", cmd: "save-file" },
        { key: "y", when: "insert", cmd: "open-file" },
      ],
    })

    expect(warnings).toEqual([
      '[ActionMap] Unknown layer field "mode" was ignored',
      '[ActionMap] Unknown binding field "when" was ignored',
    ])
  })

  test("emits unknown token warnings", () => {
    const actionMap = getActionMap(renderer)
    const { warnings } = captureDiagnostics(actionMap)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "<leader>x", cmd: "noop" },
        { key: "<leader>y", cmd: "noop" },
      ],
    })

    expect(warnings).toEqual(['[ActionMap] Unknown token "<leader>" in key sequence "<leader>x" was ignored'])
  })

  test("emits unresolved string command warnings", () => {
    const actionMap = getActionMap(renderer)
    const { warnings } = captureDiagnostics(actionMap)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "missing-command" }],
    })

    expect(warnings).toEqual(['[ActionMap] Unresolved command "missing-command" for binding "x" in global layer'])
  })

  test("does not warn about dead metadata-only bindings by default", () => {
    const actionMap = getActionMap(renderer)
    const { warnings } = captureDiagnostics(actionMap)

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x" }],
    })

    expect(warnings).toEqual([])
  })

  test("registerLayerAnalyzer analyzes compiled layers and can be unsubscribed", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const off = actionMap.appendLayerAnalyzer((ctx) => {
      calls.push(`${ctx.scope}:${ctx.order}:${ctx.compiledBindings.length}:${ctx.hasTokenBindings ? "tokens" : "plain"}`)
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: () => {} }],
    })

    off()

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "y", cmd: () => {} }],
    })

    expect(calls).toEqual(["global:0:1:plain"])
  })

  test("prependLayerAnalyzer runs before appended analyzers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendLayerAnalyzer(() => {
      calls.push("append")
    })
    actionMap.prependLayerAnalyzer(() => {
      calls.push("prepend")
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: () => {} }],
    })

    expect(calls).toEqual(["prepend", "append"])
  })

  test("clearLayerAnalyzers removes registered analyzers", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendLayerAnalyzer(() => {
      calls.push("analyzed")
    })
    actionMap.clearLayerAnalyzers()

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: () => {} }],
    })

    expect(calls).toEqual([])
  })

  test("registerLayerAnalyzer reruns on token-driven recompilation", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.appendLayerAnalyzer((ctx) => {
      calls.push(`${ctx.order}:${ctx.compiledBindings[0]?.sequence[0]?.display ?? "missing"}`)
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>x", cmd: () => {} }],
    })

    actionMap.registerToken({ name: "<leader>", key: { name: "space" } })

    expect(calls).toEqual(["0:x", "0:<leader>"])
  })

  test("registerLayerAnalyzer warnings flow through warning events", () => {
    const actionMap = getActionMap(renderer)
    const { warnings } = captureDiagnostics(actionMap)

    actionMap.appendLayerAnalyzer((ctx) => {
      ctx.warnOnce(`layer:${ctx.order}`, `layer ${ctx.order} warning`)
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: () => {} }],
    })

    expect(warnings).toEqual(["layer 0 warning"])
  })

  test("registerLayerAnalyzer errors flow through error events", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.appendLayerAnalyzer(() => {
      throw new Error("analysis boom")
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: () => {} }],
    })

    expect(errors).toEqual(["[ActionMap] Error in layer analyzer:"])
  })

  test("notifies unresolved command listeners with command, binding, scope, and target context", () => {
    const actionMap = getActionMap(renderer)
    const target = createFocusableBox("unresolved-target")
    const calls: Array<{ command: string; binding: string; scope: string; targetId?: string }> = []

    renderer.root.add(target)

    actionMap.on("unresolvedCommand", (ctx) => {
      calls.push({
        command: ctx.command,
        binding: stringifyKeySequence(ctx.binding.sequence, { preferDisplay: true }),
        scope: ctx.scope,
        targetId: ctx.target?.id,
      })
    })

    actionMap.registerLayer({
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

  test("emits runtime matcher failures as errors", () => {
    const actionMap = getActionMap(renderer)
    const { warnings, errors } = captureDiagnostics(actionMap)

    actionMap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('ActionMap binding field "active" must be true')
        }

        ctx.match(() => {
          throw new Error("boom")
        })
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "runtime-binding", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(() => actionMap.getActiveKeys()).not.toThrow()
    expect(errors.some((message) => message.includes("Error evaluating runtime matcher from field active:"))).toBe(true)
    expect(warnings).toEqual([])
  })

  test("ignores thrown warning and error listeners while notifying remaining listeners", () => {
    const actionMap = getActionMap(renderer)
    const warnings: string[] = []
    const errors: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })

    actionMap.on("warning", () => {
      throw new Error("warning listener boom")
    })
    actionMap.on("warning", (event) => {
      warnings.push(event.message)
    })
    actionMap.on("error", () => {
      throw new Error("error listener boom")
    })
    actionMap.on("error", (event) => {
      errors.push(event.message)
    })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "y", cmd: "   " }],
      })
    }).not.toThrow()

    expect(warnings).toEqual(['[ActionMap] Unknown layer field "mode" was ignored'])
    expect(errors).toEqual(["Invalid action map command: command cannot be empty"])
  })

  test("can unsubscribe warning and error listeners", () => {
    const actionMap = getActionMap(renderer)
    const warnings: string[] = []
    const errors: string[] = []
    const originalWarn = console.warn
    const originalError = console.error
    console.warn = () => {}
    console.error = () => {}

    try {
      const offWarning = actionMap.on("warning", (event) => {
        warnings.push(event.message)
      })
      const offError = actionMap.on("error", (event) => {
        errors.push(event.message)
      })

      offWarning()
      offError()

      actionMap.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [{ key: "x", cmd: "   " }],
      })
    } finally {
      console.warn = originalWarn
      console.error = originalError
    }

    expect(warnings).toEqual([])
    expect(errors).toEqual([])
  })

  test("falls back to console.warn when no warning listener is registered", () => {
    const actionMap = getActionMap(renderer)
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      actionMap.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [],
      })
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toEqual([['[ActionMap] Unknown layer field "mode" was ignored']])
  })

  test("falls back to console.error when no error listener is registered", () => {
    const actionMap = getActionMap(renderer)
    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    try {
      // Use a no-cause error path so console.error only receives the message.
      actionMap.registerCommandFields({
        name() {},
      })
    } finally {
      console.error = originalError
    }

    expect(errors).toEqual([['ActionMap command field "name" is reserved']])
  })

  test("falls back to console.error with cause when no error listener is registered", () => {
    const actionMap = getActionMap(renderer)
    const cause = new Error("filter boom")
    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })

    try {
      actionMap.getCommands({
        filter: () => {
          throw cause
        },
      })
    } finally {
      console.error = originalError
    }

    expect(errors).toEqual([["[ActionMap] Error in command query filter:", cause]])
  })

  test("does not call console.warn or console.error when a listener is registered", () => {
    const actionMap = getActionMap(renderer)
    const warnings: string[] = []
    const errors: string[] = []

    actionMap.on("warning", (event) => {
      warnings.push(event.message)
    })
    actionMap.on("error", (event) => {
      errors.push(event.message)
    })

    const originalWarn = console.warn
    const originalError = console.error
    const warnCalls: unknown[][] = []
    const errorCalls: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args)
    }
    console.error = (...args: unknown[]) => {
      errorCalls.push(args)
    }

    try {
      actionMap.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [{ key: "y", cmd: "   " }],
      })
    } finally {
      console.warn = originalWarn
      console.error = originalError
    }

    expect(warnings).toEqual(['[ActionMap] Unknown layer field "mode" was ignored'])
    expect(errors).toEqual(["Invalid action map command: command cannot be empty"])
    expect(warnCalls).toEqual([])
    expect(errorCalls).toEqual([])
  })

  test("ignores reserved command field registrations", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    expect(() => {
      actionMap.registerCommandFields({
        name() {},
      })
    }).not.toThrow()

    expect(errors).toEqual(['ActionMap command field "name" is reserved'])
  })

  test("ignores reserved layer field registrations", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    expect(() => {
      actionMap.registerLayerFields({
        scope() {},
      })
    }).not.toThrow()

    expect(errors).toEqual(['ActionMap layer field "scope" is reserved'])
  })

  test("ignores reserved and duplicate binding field registrations", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerBindingFields({
      active() {},
    })

    expect(() => {
      actionMap.registerBindingFields({
        key() {},
        active() {},
      })
    }).not.toThrow()

    expect(errors).toEqual([
      'ActionMap binding field "key" is reserved',
      'ActionMap binding field "active" is already registered',
    ])
  })

  test("skips commands with conflicting attributes from typed command fields", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("label", value)
      },
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    expect(() => {
      actionMap.registerLayer({ scope: "global", commands: [
        {
          name: "save-file",
          desc: "Save",
          title: "Write",
          run() {},
        },
      ] })
    }).not.toThrow()

    expect(errors).toEqual(['Conflicting action map attribute for "label" from field title'])
    expect(getCommand(actionMap, "save-file")).toBeUndefined()
  })

  test("keeps earlier bindings when a later binding is both an exact key and a prefix", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerLayer({ scope: "global", commands: [
      { name: "one", run() {} },
      { name: "two", run() {} },
    ] })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [
          { key: "d", cmd: "one" },
          { key: "dd", cmd: "two" },
        ],
      })
    }).not.toThrow()

    expect(errors).toEqual([
      "ActionMap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])
    expect(getActiveKey(actionMap, "d")?.command).toBe("one")
  })

  test("allows a non-dispatch binding to label a prefix", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerBindingFields({
      group(value, ctx) {
        ctx.attr("group", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "d", group: "Delete" },
        { key: "dd", cmd: "delete-line" },
      ],
    })

    const activeKey = getActiveKey(actionMap, "d", { includeBindings: true, includeMetadata: true })

    expect(activeKey?.command).toBeUndefined()
    expect(activeKey?.bindingAttrs).toEqual({ group: "Delete" })
    expect(activeKey?.bindings?.map((binding) => binding.command)).toEqual([undefined])
  })

  test("supports raw intercepts and stop semantics", () => {
    const actionMap = getActionMap(renderer)
    const rawCalls: string[] = []
    const keyCalls: string[] = []

    actionMap.intercept("raw", ({ sequence, stop }) => {
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

  test("supports release key intercepts", async () => {
    renderer.destroy()
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput

    const actionMap = getActionMap(renderer)
    const events: string[] = []

    actionMap.intercept(
      "key",
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

    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "a", cmd: "release-command", event: "release" },
        { key: "b", cmd: "press-command" },
      ],
    })

    expect(getActiveKeyNames(actionMap)).toEqual(["b"])

    mockInput.pressKey("a")
    expect(calls).toEqual([])

    renderer.stdin.emit("data", Buffer.from("\x1b[97;1:3u"))
    expect(calls).toEqual(["release"])

    mockInput.pressKey("b")
    expect(calls).toEqual(["release", "press"])
  })

  test("skips release bindings with multiple strokes", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "dd", cmd: "noop", event: "release" }],
      })
    }).not.toThrow()

    expect(errors).toEqual(["ActionMap release bindings only support a single key stroke"])
    expect(getActiveKey(actionMap, "d")).toBeUndefined()
  })

  test("ignores destroyed target layers and lets lower layers continue", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    const target = createFocusableBox("destroy-target")
    renderer.root.add(target)

    actionMap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local" }],
    })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "global" }],
    })

    target.destroy()
    mockInput.pressKey("x")

    expect(calls).toEqual(["global"])
  })

  test("passes target and runtime data to commands", () => {
    const actionMap = getActionMap(renderer)
    const seen: Array<{ target: string; command: string; mode: string }> = []

    actionMap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    actionMap.intercept("key", ({ event, setData }) => {
      if (event.name === "x") {
        setData("vim.mode", "normal")
      }
    })

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    const parent = createFocusableBox("ctx-parent")
    const child = createFocusableBox("ctx-child")
    parent.add(child)
    renderer.root.add(parent)

    actionMap.registerLayer({
      target: parent,
      bindings: [{ key: "x", mode: "normal", cmd: "record" }],
    })

    child.focus()
    mockInput.pressKey("x")

    expect(seen).toEqual([{ target: "ctx-parent", command: "record", mode: "normal" }])
  })

  test("passes fresh runtime data snapshots to commands after data changes", () => {
    const actionMap = getActionMap(renderer)
    const seen: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "record-mode",
        run(ctx) {
          seen.push(String(ctx.data["vim.mode"]))
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "record-mode" }],
    })

    actionMap.setData("vim.mode", "normal")
    mockInput.pressKey("x")

    actionMap.setData("vim.mode", "visual")
    mockInput.pressKey("x")

    expect(seen).toEqual(["normal", "visual"])
  })

  test("orders key intercepts by priority, exposes getData, and cleans them up", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.setData("vim.mode", "normal")

    const offLow = actionMap.intercept(
      "key",
      ({ event, getData }) => {
        if (event.name !== "x") {
          return
        }

        calls.push(`low:${String(getData("vim.mode"))}`)
      },
      { priority: 1 },
    )

    actionMap.intercept(
      "key",
      ({ event }) => {
        if (event.name === "x") {
          calls.push("high:first")
        }
      },
      { priority: 10 },
    )

    actionMap.intercept(
      "key",
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

  test("uses a stable key intercept snapshot when interceptors unsubscribe mid-dispatch", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    let offSecond!: () => void

    actionMap.intercept(
      "key",
      ({ event }) => {
        if (event.name !== "x") {
          return
        }

        calls.push("first")
        offSecond()
      },
      { priority: 3 },
    )

    offSecond = actionMap.intercept(
      "key",
      ({ event }) => {
        if (event.name === "x") {
          calls.push("second")
        }
      },
      { priority: 2 },
    )

    actionMap.intercept(
      "key",
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

  test("orders raw intercepts by priority and cleans them up", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    const offLow = actionMap.intercept(
      "raw",
      ({ sequence }) => {
        calls.push(`low:${sequence}`)
      },
      { priority: 1 },
    )

    actionMap.intercept(
      "raw",
      ({ sequence }) => {
        calls.push(`high:first:${sequence}`)
      },
      { priority: 10 },
    )

    actionMap.intercept(
      "raw",
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
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      scope: "global",
      priority: 1,
      bindings: [{ key: "x", cmd: "global-low" }],
    })
    actionMap.registerLayer({
      scope: "global",
      priority: 2,
      bindings: [{ key: "x", cmd: "global-high" }],
    })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "y", cmd: "older" }],
    })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "y", cmd: "newer" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["global-high", "newer"])
  })

  test("lets commands decline handling so lower layers can continue", () => {
    const actionMap = getActionMap(renderer)
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

    actionMap.registerLayer({ scope: "global", commands: [
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
    ] })

    actionMap.registerLayer({
      target,
      bindings: [{ key: "x", cmd: "local-decline" }],
    })
    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)
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

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "async-command",
        async run() {
          await Bun.sleep(0)
          calls.push("async")
        },
      },
    ] })

    actionMap.registerLayer({
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
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })

    const offLayer = actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")
    expect(actionMap.getPendingSequence()).toHaveLength(1)

    offLayer()

    expect(actionMap.getPendingSequence()).toEqual([])
  })

  test("clears pending sequences when layer requirements stop matching", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      mode: "normal",
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    actionMap.setData("vim.mode", "normal")
    mockInput.pressKey("d")
    expect(actionMap.getPendingSequence()).toHaveLength(1)

    actionMap.setData("vim.mode", "visual")

    expect(actionMap.getPendingSequence()).toEqual([])
  })

  test("can unsubscribe pending sequence listeners", () => {
    const actionMap = getActionMap(renderer)
    const changes: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-ca", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    const off = actionMap.on("pendingSequence", (sequence) => {
      changes.push(stringifyKeySequence(sequence, { preferDisplay: true }))
    })

    mockInput.pressKey("d")
    off()
    mockInput.pressKey("c")
    actionMap.clearPendingSequence()

    expect(changes).toEqual(["d"])
  })

  test("uses a stable pending sequence listener snapshot when listeners unsubscribe mid-notification", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-ca", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    let offSecond!: () => void

    actionMap.on("pendingSequence", (sequence) => {
      calls.push(`first:${stringifyKeySequence(sequence, { preferDisplay: true })}`)
      offSecond()
    })

    offSecond = actionMap.on("pendingSequence", (sequence) => {
      calls.push(`second:${stringifyKeySequence(sequence, { preferDisplay: true })}`)
    })

    mockInput.pressKey("d")
    actionMap.clearPendingSequence()

    expect(calls).toEqual(["first:d", "second:d", "first:"])
  })

  test("emits pending sequence listener failures and continues notifying remaining listeners", () => {
    const changes: string[] = []
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "delete-ca", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "dca", cmd: "delete-ca" }],
    })

    actionMap.on("pendingSequence", () => {
      throw new Error("boom")
    })
    actionMap.on("pendingSequence", (sequence) => {
      changes.push(stringifyKeySequence(sequence, { preferDisplay: true }))
    })

    mockInput.pressKey("d")

    expect(changes).toEqual(["d"])
    expect(errors.some((message) => message.includes("Error in pending sequence listener:"))).toBe(true)
  })

  test("recompiles tokenized layers when tokens are registered and disposed", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "leader-action",
        run() {
          calls.push("leader")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>a", cmd: "leader-action" }],
    })

    expect(getActiveKeyNames(actionMap)).toEqual(["a"])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader"])

    const offToken = actionMap.registerToken({
      name: "<leader>",
      key: { name: "x", ctrl: true },
    })

    expect(getActiveKeyNames(actionMap)).toEqual(["x"])
    expect(getActiveKeyDisplay(actionMap, "<leader>")?.command).toBeUndefined()

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader"])

    mockInput.pressKey("x", { ctrl: true })
    expect(stringifyKeySequence(actionMap.getPendingSequence(), { preferDisplay: true })).toBe("<leader>")
    expect(getActiveKeyNames(actionMap)).toEqual(["a"])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader", "leader"])

    offToken()

    expect(getActiveKeyNames(actionMap)).toEqual(["a"])

    mockInput.pressKey("a")
    expect(calls).toEqual(["leader", "leader", "leader"])
  })

  test("keeps token-only bindings inactive until the token is registered", () => {
    const actionMap = getActionMap(renderer)
    const calls: string[] = []

    actionMap.registerLayer({ scope: "global", commands: [
      {
        name: "leader-only",
        run() {
          calls.push("leader-only")
        },
      },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>", cmd: "leader-only" }],
    })

    expect(actionMap.getActiveKeys()).toEqual([])

    actionMap.registerToken({
      name: "<leader>",
      key: { name: "x", ctrl: true },
    })

    expect(getActiveKeyDisplay(actionMap, "<leader>")?.command).toBe("leader-only")

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["leader-only"])
  })

  test("clears pending tokenized sequences when token registration recompiles their layer", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "leader-action", run() {} }] })
    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "<leader>ab", cmd: "leader-action" }],
    })

    mockInput.pressKey("a")

    expect(actionMap.getPendingSequence()).toEqual([
      { stroke: { name: "a", ctrl: false, shift: false, meta: false, super: false }, display: "a", matchKey: "a:0:0:0:0:0" },
    ])

    actionMap.registerToken({
      name: "<leader>",
      key: { name: "x", ctrl: true },
    })

    expect(actionMap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames(actionMap)).toEqual(["x"])
  })

  test("skips conflicting tokenized bindings when token registration creates a prefix conflict", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    actionMap.registerLayer({ scope: "global", commands: [
      { name: "plain", run() {} },
      { name: "tokenized", run() {} },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "a", cmd: "plain" },
        { key: "<leader>b", cmd: "tokenized" },
      ],
    })

    expect(getActiveKeyNames(actionMap)).toEqual(["a", "b"])

    expect(() => {
      actionMap.registerToken({
        name: "<leader>",
        key: "a",
      })
    }).not.toThrow()

    expect(errors).toEqual([
      "ActionMap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
    ])
    expect(getActiveKeyNames(actionMap)).toEqual(["a"])
  })

  test("can dispose layer, binding, and command field registrations", () => {
    const actionMap = getActionMap(renderer)

    actionMap.registerLayer({ scope: "global", commands: [{ name: "noop", run() {} }] })

    const offLayerFields = actionMap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    offLayerFields()

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames(actionMap)).toContain("x")

    const offBindingFields = actionMap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })
    offBindingFields()

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "y", mode: "normal", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames(actionMap)).toContain("y")

    const offCommandFields = actionMap.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
    })
    offCommandFields()

    expect(() => {
      actionMap.registerLayer({ scope: "global", commands: [
        {
          name: "noop-with-desc",
          desc: "No operation",
          run() {},
        },
      ] })
    }).not.toThrow()

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "z", cmd: "noop-with-desc" }],
    })

    expect(getActiveKeyNames(actionMap)).toContain("z")
  })

  test("getActiveKeys follows dispatch order and fallthrough across layers", () => {
    const actionMap = getActionMap(renderer)
    const target = createFocusableBox("dispatch-active-target")

    renderer.root.add(target)

    actionMap.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("desc", value)
      },
    })
    actionMap.registerCommandFields({
      category(value, ctx) {
        ctx.attr("category", value)
      },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      { name: "save", category: "File", run() {} },
      { name: "help", category: "Help", run() {} },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [
        { key: "x", cmd: "save", desc: "Global x" },
        { key: "y", cmd: "help", desc: "Global y" },
      ],
    })
    actionMap.registerLayer({
      target,
      bindings: [
        { key: "x", cmd: "help", desc: "Local x" },
        { key: "y", cmd: "save", desc: "Local y", fallthrough: true },
      ],
    })

    target.focus()

    const activeX = getActiveKey(actionMap, "x", { includeBindings: true, includeMetadata: true })

    expect(activeX?.command).toBe("help")
    expect(activeX?.bindings?.map((binding) => binding.command)).toEqual(["help"])
    expect(activeX?.bindingAttrs).toEqual({ desc: "Local x" })

    const activeY = getActiveKey(actionMap, "y", { includeBindings: true, includeMetadata: true })

    expect(activeY?.command).toBe("save")
    expect(activeY?.bindings?.map((binding) => binding.command)).toEqual(["save", "help"])
    expect(activeY?.bindingAttrs).toEqual({ desc: "Local y" })
  })

  test("getActiveKeys uses the first matching prefix layer before lower exact layers", () => {
    const actionMap = getActionMap(renderer)
    const target = createFocusableBox("prefix-dispatch-target")

    renderer.root.add(target)

    actionMap.registerToken({
      name: "<leader>",
      key: { name: "x", ctrl: true },
    })

    actionMap.registerLayer({ scope: "global", commands: [
      { name: "plain", run() {} },
      { name: "leader", run() {} },
    ] })

    actionMap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+x", cmd: "plain" }],
    })
    actionMap.registerLayer({
      target,
      bindings: [{ key: "<leader>a", cmd: "leader" }],
    })

    target.focus()

    const activeKey = actionMap
      .getActiveKeys()
      .find((candidate) => candidate.stroke.name === "x" && candidate.stroke.ctrl)

    expect(activeKey?.command).toBeUndefined()
    expect(activeKey?.continues).toBe(true)
  })

  test("validates command names and command inputs", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    expect(() => {
      actionMap.registerLayer({ scope: "global", commands: [{ name: "", run() {} }] })
    }).not.toThrow()

    expect(() => {
      actionMap.registerLayer({ scope: "global", commands: [{ name: "bad name", run() {} }] })
    }).not.toThrow()

    expect(() => {
      actionMap.registerLayer({
        scope: "global",
        bindings: [{ key: "x", cmd: "   " }],
      })
    }).not.toThrow()

    expect(errors).toEqual([
      "Invalid action map command name: name cannot be empty",
      'Invalid action map command name "bad name": command names cannot contain whitespace',
      "Invalid action map command: command cannot be empty",
    ])
    expect(actionMap.getCommands()).toEqual([])
    expect(getActiveKey(actionMap, "x")).toBeUndefined()
    expect(actionMap.runCommand("   ")).toEqual({ ok: false, reason: "invalid-args" })
  })

  test("requires registered token keys to resolve to a single key stroke", () => {
    const actionMap = getActionMap(renderer)
    const { errors } = captureDiagnostics(actionMap)

    expect(() => {
      actionMap.registerToken({ name: "<leader>", key: "dd" })
    }).not.toThrow()

    expect(errors).toEqual(['Invalid key "dd": expected a single key stroke'])
  })
})
