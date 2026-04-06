import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { BoxRenderable } from "@opentui/core"
import { Show, createSignal } from "solid-js"
import { testRender, useKeymap, useKeymappings } from "../index.js"

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
      useKeymap({
        scope: "global",
        bindings: {
          x: () => {
            calls.push("global")
          },
        },
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

  test("useKeymap registers target bindings through a renderable ref", async () => {
    const calls: string[] = []
    let setFirstFocused!: (value: boolean) => void
    let setSecondFocused!: (value: boolean) => void

    function App() {
      const [firstFocused, setFirstFocusedSignal] = createSignal(true)
      const [secondFocused, setSecondFocusedSignal] = createSignal(false)
      setFirstFocused = setFirstFocusedSignal
      setSecondFocused = setSecondFocusedSignal

      let target: BoxRenderable | undefined

      useKeymap({
        target: () => target,
        bindings: {
          x: () => {
            calls.push("target")
          },
        },
      })

      return (
        <box width={20} height={6}>
          <box ref={(value) => (target = value)} width={8} height={3} focusable focused={firstFocused()} />
          <box width={8} height={3} focusable focused={secondFocused()} />
        </box>
      )
    }

    testSetup = await testRender(() => <App />, { width: 20, height: 6 })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["target"])

    setFirstFocused(false)
    setSecondFocused(true)
    await Bun.sleep(0)

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["target"])
  })
})
