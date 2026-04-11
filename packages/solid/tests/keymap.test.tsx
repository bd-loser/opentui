import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { registerEnabledField, stringifyKeySequence } from "@opentui/core/extras"
import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { testRender, useActiveKeys, useKeymap, useKeymappings, usePendingSequenceParts } from "../index.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("solid keymap hooks", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  test("useKeymappings returns the renderer-scoped singleton", async () => {
    let first: ReturnType<typeof useKeymappings> | undefined
    let second: ReturnType<typeof useKeymappings> | undefined

    function Probe() {
      first = useKeymappings()
      second = useKeymappings()

      return <box width={10} height={4} />
    }

    testSetup = await testRender(() => <Probe />, { width: 20, height: 6 })

    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  test("useKeymap registers global bindings and cleans them up on unmount", async () => {
    const calls: string[] = []
    let setVisible!: (value: boolean) => void

    function GlobalBindings() {
      const manager = useKeymappings()
      const offCommands = manager.registerCommands([
        {
          name: "global",
          run() {
            calls.push("global")
          },
        },
      ])

      useKeymap({
        scope: "global",
        bindings: {
          x: "global",
        },
      })

      onCleanup(() => {
        offCommands()
      })

      return <text>bindings</text>
    }

    function App() {
      const [visible, setVisibleSignal] = createSignal(true)
      setVisible = setVisibleSignal

      return (
        <box width={20} height={6}>
          <Show when={visible()}>
            <GlobalBindings />
          </Show>
        </box>
      )
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["global"])

    setVisible(false)
    await Bun.sleep(0)

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["global"])
  })

  test("useActiveKeys updates on focus changes and direct blur", async () => {
    let firstTarget!: Renderable
    let secondTarget!: Renderable

    function App() {
      const manager = useKeymappings()
      const activeKeys = useActiveKeys()
      const offCommands = manager.registerCommands([
        { name: "first", run() {} },
        { name: "second", run() {} },
      ])

      const firstKeymapRef = useKeymap({
        scope: "focus-within",
        bindings: { x: "first" },
      })
      const secondKeymapRef = useKeymap({
        scope: "focus-within",
        bindings: { y: "second" },
      })

      onCleanup(() => {
        offCommands()
      })

      return (
        <box width={24} height={8} flexDirection="column">
          <text>{`Active: ${activeKeys().map((key) => key.stroke.name).join(",") || "<none>"}`}</text>
          <box
            ref={(value: Renderable) => {
              firstKeymapRef(value)
              firstTarget = value
            }}
            width={8}
            height={2}
            focusable
            focused
          />
          <box
            ref={(value: Renderable) => {
              secondKeymapRef(value)
              secondTarget = value
            }}
            width={8}
            height={2}
            focusable
          />
        </box>
      )
    }

    testSetup = await testRender(() => <App />, { width: 24, height: 8 })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: x")

    secondTarget.focus()
    await Bun.sleep(0)
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: y")

    secondTarget.blur()
    await Bun.sleep(0)
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: <none>")
  })

  test("usePendingSequenceParts updates without manual subscriptions", async () => {
    function App() {
      const manager = useKeymappings()
      const pendingSequenceParts = usePendingSequenceParts()
      const offCommands = manager.registerCommands([{ name: "delete-line", run() {} }])

      useKeymap({
        scope: "global",
        bindings: [{ key: "dd", cmd: "delete-line" }],
      })

      onCleanup(() => {
        offCommands()
      })

      return <text>{`Pending: ${stringifyKeySequence(pendingSequenceParts(), { preferDisplay: true }) || "<root>"}`}</text>
    }

    testSetup = await testRender(() => <App />, { width: 24, height: 6 })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: <root>")

    testSetup.mockInput.pressKey("d")
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: d")

    testSetup.mockInput.pressKey("x")
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: <root>")
  })

  test("useKeymap can bind local keymaps through its returned ref", async () => {
    const calls: string[] = []
    let setActive!: (value: "first" | "second") => void

    function App() {
      const manager = useKeymappings()
      const [active, setActiveSignal] = createSignal<"first" | "second">("first")
      setActive = setActiveSignal

      const offCommands = manager.registerCommands([
        {
          name: "target",
          run() {
            calls.push("target")
          },
        },
      ])

      onCleanup(() => {
        offCommands()
      })

      const keymapRef = useKeymap({
        scope: "focus-within",
        bindings: [{ key: "x", cmd: "target" }],
      })

      return (
        <box width={20} height={6}>
          <box ref={keymapRef} width={8} height={3} focusable focused={active() === "first"} />
          <box width={8} height={3} focusable focused={active() === "second"} />
        </box>
      )
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["target"])

    setActive("second")
    await Bun.sleep(0)

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["target"])
  })

  test("useKeymap can reactively enable layers with explicit keyed invalidation", async () => {
    const calls: string[] = []
    let setEnabled!: (value: boolean) => void

    function App() {
      const manager = useKeymappings()
      const [enabled, setEnabledSignal] = createSignal(false)
      setEnabled = setEnabledSignal

      const offEnabled = registerEnabledField(manager)
      const offCommands = manager.registerCommands([
        {
          name: "reactive",
          run() {
            calls.push("reactive")
          },
        },
      ])

      createEffect(() => {
        enabled()
        manager.invalidateRuntimeKey("solid.enabled")
      })

      useKeymap({
        scope: "global",
        enabled: {
          match: enabled,
          keys: ["solid.enabled"],
        },
        bindings: { x: "reactive" },
      })

      onCleanup(() => {
        offCommands()
        offEnabled()
      })

      return <box width={20} height={6} />
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual([])

    setEnabled(true)
    await Bun.sleep(0)

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["reactive"])

    setEnabled(false)
    await Bun.sleep(0)

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["reactive"])
  })

  test("useKeymap rejects local bindings without a target or ref", async () => {
    function App() {
      useKeymap({
        scope: "focus-within",
        bindings: { x: "target" },
      })

      return <text>bindings</text>
    }

    await expect(
      testRender(() => <App />, {
        width: 20,
        height: 6,
      }),
    ).rejects.toThrow("useKeymap local bindings need a target or the returned ref callback attached to a renderable")
  })

  test("useKeymap rejects explicit targets that are unavailable during mount", async () => {
    function App() {
      useKeymap({
        scope: "focus-within",
        target: () => undefined,
        bindings: { x: "target" },
      })

      return <text>bindings</text>
    }

    await expect(
      testRender(() => <App />, {
        width: 20,
        height: 6,
      }),
    ).rejects.toThrow("useKeymap target was not available during mount")
  })
})
