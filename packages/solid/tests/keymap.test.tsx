import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { registerActionCommands } from "@opentui/core/extras"
import { Show, createSignal, onCleanup } from "solid-js"
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
      const manager = useKeymappings()
      const offCommands = registerActionCommands(manager, [
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

  test("useKeymap can bind local keymaps through its returned ref", async () => {
    const calls: string[] = []
    let setActive!: (value: "first" | "second") => void

    function App() {
      const manager = useKeymappings()
      const [active, setActiveSignal] = createSignal<"first" | "second">("first")
      setActive = setActiveSignal

      const offCommands = registerActionCommands(manager, [
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
})
