import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable } from "../../../renderables/Box.js"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getActionMap } from "../index.js"
import { registerExCommands } from "./ex-commands.js"

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

describe("ex commands addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("supports aliases and nargs validation", () => {
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

    manager.registerLayer({
      scope: "global",
      bindings: [
        { key: "x", cmd: "fallback" },
        { key: "y", cmd: ":w file.txt" },
      ],
    })

    manager.registerLayer({
      target,
      bindings: [{ key: "x", cmd: ":write" }],
    })

    target.focus()
    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["fallback", "write:file.txt"])
  })

  test("supports colon-prefixed names and each nargs mode", () => {
    const manager = getActionMap(renderer)
    const calls: string[] = []
    let passthroughCount = 0

    registerExCommands(manager, [
      {
        name: ":quit",
        nargs: "0",
        run() {
          calls.push("quit")
        },
      },
      {
        name: "maybe",
        nargs: "?",
        run({ args }) {
          calls.push(`maybe:${args.join(",")}`)
        },
      },
      {
        name: "many",
        nargs: "*",
        run({ args }) {
          calls.push(`many:${args.join(",")}`)
        },
      },
      {
        name: "plus",
        nargs: "+",
        run({ args }) {
          calls.push(`plus:${args.join(",")}`)
        },
      },
      {
        name: "free",
        run({ args }) {
          calls.push(`free:${args.join(",")}`)
        },
      },
    ])

    const target = createFocusableBox("nargs-target")
    target.onKeyDown = () => {
      passthroughCount += 1
    }
    renderer.root.add(target)

    manager.registerLayer({
      target,
      bindings: [
        { key: "a", cmd: ":quit" },
        { key: "b", cmd: ":quit now" },
        { key: "c", cmd: ":maybe" },
        { key: "d", cmd: ":maybe one" },
        { key: "e", cmd: ":maybe one two" },
        { key: "f", cmd: ":many" },
        { key: "g", cmd: ":many one two" },
        { key: "h", cmd: ":plus" },
        { key: "i", cmd: ":plus one" },
        { key: "j", cmd: ":free one two" },
      ],
    })

    target.focus()

    mockInput.pressKey("a")
    mockInput.pressKey("b")
    mockInput.pressKey("c")
    mockInput.pressKey("d")
    mockInput.pressKey("e")
    mockInput.pressKey("f")
    mockInput.pressKey("g")
    mockInput.pressKey("h")
    mockInput.pressKey("i")
    mockInput.pressKey("j")

    expect(calls).toEqual(["quit", "maybe:", "maybe:one", "many:", "many:one,two", "plus:one", "free:one,two"])
    expect(passthroughCount).toBe(3)
  })

  test("forwards extra command fields into registered ex commands", () => {
    const manager = getActionMap(renderer)

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

    registerExCommands(manager, [
      {
        name: "write",
        aliases: ["w"],
        nargs: "1",
        desc: "Write the current buffer",
        title: "Write Buffer",
        category: "File",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: ":w file.txt" }],
    })

    expect(
      manager.getActiveKeys({ includeMetadata: true }).find((candidate) => candidate.stroke.name === "x")?.commandAttrs,
    ).toEqual({
      desc: "Write the current buffer",
      title: "Write Buffer",
      category: "File",
    })

    expect(manager.getCommands({ filter: { namespace: "excommands" } })).toEqual([
      {
        name: ":write",
        fields: {
          aliases: ["w"],
          nargs: "1",
          desc: "Write the current buffer",
          title: "Write Buffer",
          category: "File",
          namespace: "excommands",
        },
        attrs: {
          desc: "Write the current buffer",
          title: "Write Buffer",
          category: "File",
        },
      },
      {
        name: ":w",
        fields: {
          aliases: ["w"],
          nargs: "1",
          desc: "Write the current buffer",
          title: "Write Buffer",
          category: "File",
          namespace: "excommands",
        },
        attrs: {
          desc: "Write the current buffer",
          title: "Write Buffer",
          category: "File",
        },
      },
    ])
  })

  test("can be disposed to remove ex-command resolution", () => {
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

    const offExCommands = registerExCommands(manager, [
      {
        name: "write",
        aliases: ["w"],
        run({ args }) {
          calls.push(`write:${args.join(",")}`)
        },
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: ":w file.txt" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual(["write:file.txt"])

    offExCommands()

    mockInput.pressKey("x")
    expect(calls).toEqual(["write:file.txt", "fallback"])
  })

  test("runCommand resolves ex commands programmatically", () => {
    const manager = getActionMap(renderer)
    const calls: string[] = []

    registerExCommands(manager, [
      {
        name: "write",
        aliases: ["w"],
        nargs: "1",
        usage: ":write <file>",
        run({ raw, args }) {
          calls.push(`${raw}:${args.join(",")}`)
        },
      },
    ])

    expect(manager.runCommand(":w file.txt")).toEqual({
      ok: true,
    })
    expect(manager.runCommand(":w file.txt", { includeCommand: true })).toEqual({
      ok: true,
      command: {
        name: ":w",
        fields: {
          aliases: ["w"],
          nargs: "1",
          usage: ":write <file>",
          namespace: "excommands",
        },
      },
    })
    expect(manager.runCommand(":w")).toEqual({
      ok: false,
      reason: "invalid-args",
    })
    expect(manager.runCommand(":w", { includeCommand: true })).toEqual({
      ok: false,
      reason: "invalid-args",
      command: {
        name: ":w",
        fields: {
          aliases: ["w"],
          nargs: "1",
          usage: ":write <file>",
          namespace: "excommands",
        },
      },
    })
    expect(manager.runCommand(":missing")).toEqual({ ok: false, reason: "not-found" })
    expect(calls).toEqual([":w file.txt:file.txt", ":w file.txt:file.txt"])
  })
})
