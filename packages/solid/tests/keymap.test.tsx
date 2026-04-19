import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { addons, stringifyKeySequence } from "@opentui/core/extras"
import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import {
  reactiveMatcherFromSignal,
  testRender,
  useKeymap,
  useActiveKeys,
  useBindings,
  usePendingSequence,
} from "../index.js"

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

  test("useKeymap returns the renderer-scoped singleton", async () => {
    let first: ReturnType<typeof useKeymap> | undefined
    let second: ReturnType<typeof useKeymap> | undefined

    function Probe() {
      first = useKeymap()
      second = useKeymap()

      return <box width={10} height={4} />
    }

    testSetup = await testRender(() => <Probe />, { width: 20, height: 6 })

    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  test("useBindings registers global bindings and cleans them up on unmount", async () => {
    const calls: string[] = []
    let setVisible!: (value: boolean) => void

    function GlobalBindings() {
      const manager = useKeymap()
      const offCommands = manager.registerLayer({
        scope: "global",
        commands: [
          {
            name: "global",
            run() {
              calls.push("global")
            },
          },
        ],
      })

      useBindings({
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

  test("inline useBindings layer objects do not re-register on Solid reactive updates", async () => {
    let setTick!: (value: number) => void
    let registerCalls = 0

    function App() {
      const manager = useKeymap()
      const [tick, setTickSignal] = createSignal(0)
      setTick = setTickSignal

      const offCommands = manager.registerLayer({ scope: "global", commands: [{ name: "probe", run() {} }] })
      const original = manager.registerLayer.bind(manager)
      manager.registerLayer = ((layer) => {
        registerCalls += 1
        return original(layer)
      }) as typeof manager.registerLayer

      useBindings({
        scope: "global",
        bindings: { x: "probe" },
      })

      onCleanup(() => {
        manager.registerLayer = original
        offCommands()
      })

      return <text>{tick()}</text>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    expect(registerCalls).toBe(1)

    setTick(1)
    await Bun.sleep(0)

    expect(registerCalls).toBe(1)
  })

  test("useActiveKeys updates on focus changes and direct blur", async () => {
    let firstTarget!: Renderable
    let secondTarget!: Renderable

    function App() {
      const manager = useKeymap()
      const activeKeys = useActiveKeys()
      const offCommands = manager.registerLayer({
        scope: "global",
        commands: [
          { name: "first", run() {} },
          { name: "second", run() {} },
        ],
      })

      const firstBindingsRef = useBindings({
        scope: "focus-within",
        bindings: { x: "first" },
      })
      const secondBindingsRef = useBindings({
        scope: "focus-within",
        bindings: { y: "second" },
      })

      onCleanup(() => {
        offCommands()
      })

      return (
        <box width={24} height={8} flexDirection="column">
          <text>{`Active: ${
            activeKeys()
              .map((key) => key.stroke.name)
              .join(",") || "<none>"
          }`}</text>
          <box
            ref={(value: Renderable) => {
              firstBindingsRef(value)
              firstTarget = value
            }}
            width={8}
            height={2}
            focusable
            focused
          />
          <box
            ref={(value: Renderable) => {
              secondBindingsRef(value)
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

  test("usePendingSequence updates without manual subscriptions", async () => {
    function App() {
      const manager = useKeymap()
      const pendingSequence = usePendingSequence()
      const offCommands = manager.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })

      useBindings({
        scope: "global",
        bindings: [{ key: "dd", cmd: "delete-line" }],
      })

      onCleanup(() => {
        offCommands()
      })

      return <text>{`Pending: ${stringifyKeySequence(pendingSequence(), { preferDisplay: true }) || "<root>"}`}</text>
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

  test("useBindings can bind local bindings through its returned ref", async () => {
    const calls: string[] = []
    let setActive!: (value: "first" | "second") => void

    function App() {
      const manager = useKeymap()
      const [active, setActiveSignal] = createSignal<"first" | "second">("first")
      setActive = setActiveSignal

      const offCommands = manager.registerLayer({
        scope: "global",
        commands: [
          {
            name: "target",
            run() {
              calls.push("target")
            },
          },
        ],
      })

      onCleanup(() => {
        offCommands()
      })

      const bindingsRef = useBindings({
        scope: "focus-within",
        bindings: [{ key: "x", cmd: "target" }],
      })

      return (
        <box width={20} height={6}>
          <box ref={bindingsRef} width={8} height={3} focusable focused={active() === "first"} />
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

  test("useBindings can reactively enable layers with a Solid signal", async () => {
    const calls: string[] = []
    let setEnabled!: (value: boolean) => void

    function App() {
      const manager = useKeymap()
      const [enabled, setEnabledSignal] = createSignal(false)
      setEnabled = setEnabledSignal

      const offEnabled = addons.registerEnabledField(manager)
      const offCommands = manager.registerLayer({
        scope: "global",
        commands: [
          {
            name: "reactive",
            run() {
              calls.push("reactive")
            },
          },
        ],
      })

      useBindings({
        scope: "global",
        enabled: reactiveMatcherFromSignal(enabled),
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
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["reactive"])

    setEnabled(false)
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["reactive"])
  })

  test("useBindings rejects local bindings without a target or ref", async () => {
    function App() {
      useBindings({
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
    ).rejects.toThrow("useBindings local bindings need a target or the returned ref callback attached to a renderable")
  })

  test("useBindings rejects explicit targets that are unavailable during mount", async () => {
    function App() {
      useBindings({
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
    ).rejects.toThrow("useBindings target was not available during mount")
  })

  test("reactiveMatcherFromSignal: coerces accessor value and re-evaluates on signal change", async () => {
    const calls: string[] = []
    let setEnabled!: (value: boolean) => void

    function App() {
      const manager = useKeymap()
      const offCommands = manager.registerLayer({
        scope: "global",
        commands: [
          {
            name: "guarded",
            run() {
              calls.push("guarded")
            },
          },
        ],
      })
      onCleanup(offCommands)

      addons.registerEnabledField(manager)

      const [enabled, setter] = createSignal(false)
      setEnabled = setter

      useBindings({
        scope: "global",
        enabled: reactiveMatcherFromSignal(enabled),
        bindings: { x: "guarded" },
      })

      return <text>reactive</text>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual([])

    setEnabled(true)
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["guarded"])

    setEnabled(false)
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["guarded"])
  })

  test("reactiveMatcherFromSignal: disposes reactive scope on layer unregister", async () => {
    let unmount!: () => void
    let setEnabled!: (value: boolean) => void
    const evaluations: number[] = []

    function Child() {
      const [enabled, setter] = createSignal(false)
      setEnabled = setter

      const matcher = reactiveMatcherFromSignal(() => {
        const value = enabled()
        evaluations.push(evaluations.length)
        return value
      })

      useBindings({
        scope: "global",
        enabled: matcher,
        bindings: { x: "probe" },
      })

      return <text>child</text>
    }

    function App() {
      const [mounted, setMounted] = createSignal(true)
      unmount = () => setMounted(false)

      const manager = useKeymap()
      addons.registerEnabledField(manager)
      const offCommands = manager.registerLayer({ scope: "global", commands: [{ name: "probe", run() {} }] })
      onCleanup(offCommands)

      return <Show when={mounted()}>{() => <Child />}</Show>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    setEnabled(true)
    const evaluationsBeforeUnmount = evaluations.length
    expect(evaluationsBeforeUnmount).toBeGreaterThan(0)

    // After unmount, signal changes must not re-evaluate the matcher.
    unmount()

    setEnabled(false)
    setEnabled(true)

    expect(evaluations.length).toBe(evaluationsBeforeUnmount)
  })

  test("reactiveMatcherFromSignal: applies predicate when signal value is not boolean", async () => {
    const calls: string[] = []
    let setMode!: (value: "normal" | "visual") => void

    function App() {
      const manager = useKeymap()
      const offCommands = manager.registerLayer({
        scope: "global",
        commands: [
          {
            name: "normal-only",
            run() {
              calls.push("normal")
            },
          },
        ],
      })
      onCleanup(offCommands)

      addons.registerEnabledField(manager)

      const [mode, setter] = createSignal<"normal" | "visual">("visual")
      setMode = setter

      useBindings({
        scope: "global",
        enabled: reactiveMatcherFromSignal(mode, (value) => value === "normal"),
        bindings: { x: "normal-only" },
      })

      return <text>mode</text>
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual([])

    setMode("normal")
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["normal"])

    setMode("visual")
    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["normal"])
  })
})
