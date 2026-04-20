import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { registerBaseLayoutFallback } from "@opentui/keymap/addons/opentui"
import { getKeymap } from "@opentui/keymap/opentui"

let renderer: TestRenderer

describe("base layout fallback addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("matches bindings through Kitty base-layout codepoints", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerBaseLayoutFallback(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "copy",
          run() {
            calls.push("copy")
          },
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+c", cmd: "copy" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[12618::99;5u"))

    expect(calls).toEqual(["copy"])
  })

  test("keeps direct stroke matches ahead of base-layout fallbacks", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerBaseLayoutFallback(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "fallback-copy",
          run() {
            calls.push("fallback")
          },
        },
        {
          name: "direct-copy",
          run() {
            calls.push("direct")
          },
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      bindings: [
        { key: "ctrl+c", cmd: "fallback-copy" },
        { key: { name: "\u314a", ctrl: true }, cmd: "direct-copy" },
      ],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[12618::99;5u"))

    expect(calls).toEqual(["direct"])
  })

  test("can be disposed to stop base-layout fallback matching", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const offFallback = registerBaseLayoutFallback(keymap)
    offFallback()

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "copy",
          run() {
            calls.push("copy")
          },
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      bindings: [{ key: "ctrl+c", cmd: "copy" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[12618::99;5u"))

    expect(calls).toEqual([])
  })
})
