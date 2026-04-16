import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { act } from "react"
import { registerEnabledField, stringifyKeySequence } from "@opentui/core/extras"
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react"
import { testRender } from "../src/test-utils.js"
import { useActiveKeys, useKeymap, useKeymappings, usePendingSequenceParts } from "../src/index.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("React keymap hooks", () => {
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

    testSetup = await testRender(<Probe />, { width: 20, height: 6 })

    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  test("useKeymap registers global bindings and cleans them up on unmount", async () => {
    const calls: string[] = []
    let setVisible!: Dispatch<SetStateAction<boolean>>

    function GlobalBindings() {
      const manager = useKeymappings()

      useEffect(() => {
        return manager.registerCommands([
          {
            name: "global",
            run() {
              calls.push("global")
            },
          },
        ])
      }, [manager])

      const layer = useMemo(
        () => ({
          scope: "global" as const,
          bindings: { x: "global" },
        }),
        [],
      )

      useKeymap(layer)

      return <text>bindings</text>
    }

    function App() {
      const [visible, setVisibleSignal] = useState(true)
      setVisible = setVisibleSignal

      return (
        <box width={20} height={6}>
          {visible ? <GlobalBindings /> : null}
        </box>
      )
    }

    testSetup = await testRender(<App />, { width: 20, height: 6 })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["global"])

    act(() => {
      setVisible(false)
    })
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["global"])
  })

  test("useActiveKeys updates on focus changes and direct blur", async () => {
    let firstTarget!: Renderable
    let secondTarget!: Renderable

    function App() {
      const manager = useKeymappings()
      const activeKeys = useActiveKeys()

      useEffect(() => {
        return manager.registerCommands([
          { name: "first", run() {} },
          { name: "second", run() {} },
        ])
      }, [manager])

      const firstLayer = useMemo(
        () => ({
          scope: "focus-within" as const,
          bindings: { x: "first" },
        }),
        [],
      )
      const secondLayer = useMemo(
        () => ({
          scope: "focus-within" as const,
          bindings: { y: "second" },
        }),
        [],
      )

      const firstKeymapRef = useKeymap(firstLayer)
      const secondKeymapRef = useKeymap(secondLayer)

      return (
        <box width={24} height={8} flexDirection="column">
          <text>{`Active: ${activeKeys.map((key) => key.stroke.name).join(",") || "<none>"}`}</text>
          <box
            ref={(value) => {
              firstKeymapRef(value)
              if (value) {
                firstTarget = value
              }
            }}
            width={8}
            height={2}
            focusable
            focused
          />
          <box
            ref={(value) => {
              secondKeymapRef(value)
              if (value) {
                secondTarget = value
              }
            }}
            width={8}
            height={2}
            focusable
          />
        </box>
      )
    }

    testSetup = await testRender(<App />, { width: 24, height: 8 })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: x")

    act(() => {
      secondTarget.focus()
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: y")

    act(() => {
      secondTarget.blur()
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: <none>")
  })

  test("usePendingSequenceParts updates without manual subscriptions", async () => {
    function App() {
      const manager = useKeymappings()
      const pendingSequenceParts = usePendingSequenceParts()

      useEffect(() => {
        return manager.registerCommands([{ name: "delete-line", run() {} }])
      }, [manager])

      const layer = useMemo(
        () => ({
          scope: "global" as const,
          bindings: [{ key: "dd", cmd: "delete-line" }],
        }),
        [],
      )

      useKeymap(layer)

      return (
        <text>{`Pending: ${stringifyKeySequence(pendingSequenceParts, { preferDisplay: true }) || "<root>"}`}</text>
      )
    }

    testSetup = await testRender(<App />, { width: 24, height: 6 })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: <root>")

    act(() => {
      testSetup.mockInput.pressKey("d")
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: d")

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: <root>")
  })

  test("useKeymap can bind local keymaps through its returned ref", async () => {
    const calls: string[] = []
    let setActive!: Dispatch<SetStateAction<"first" | "second">>

    function App() {
      const manager = useKeymappings()
      const [active, setActiveSignal] = useState<"first" | "second">("first")
      setActive = setActiveSignal

      useEffect(() => {
        return manager.registerCommands([
          {
            name: "target",
            run() {
              calls.push("target")
            },
          },
        ])
      }, [manager])

      const layer = useMemo(
        () => ({
          scope: "focus-within" as const,
          bindings: [{ key: "x", cmd: "target" }],
        }),
        [],
      )

      const keymapRef = useKeymap(layer)

      return (
        <box width={20} height={6}>
          <box ref={keymapRef} width={8} height={3} focusable focused={active === "first"} />
          <box width={8} height={3} focusable focused={active === "second"} />
        </box>
      )
    }

    testSetup = await testRender(<App />, { width: 20, height: 6 })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["target"])

    act(() => {
      setActive("second")
    })
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["target"])
  })

  test("useKeymap follows a stable ref when it retargets to a new renderable", async () => {
    const calls: string[] = []
    let setActive!: Dispatch<SetStateAction<"first" | "second">>

    function App() {
      const manager = useKeymappings()
      const [active, setActiveSignal] = useState<"first" | "second">("first")
      setActive = setActiveSignal

      useEffect(() => {
        return manager.registerCommands([
          {
            name: "target",
            run() {
              calls.push("target")
            },
          },
        ])
      }, [manager])

      const layer = useMemo(
        () => ({
          scope: "focus-within" as const,
          bindings: [{ key: "x", cmd: "target" }],
        }),
        [],
      )

      const keymapRef = useKeymap(layer)

      return (
        <box width={20} height={6}>
          {active === "first" ? (
            <box key="first" id="first" ref={keymapRef} width={8} height={3} focusable focused />
          ) : (
            <box key="second" id="second" ref={keymapRef} width={8} height={3} focusable focused />
          )}
        </box>
      )
    }

    testSetup = await testRender(<App />, { width: 20, height: 6 })
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["target"])

    act(() => {
      setActive("second")
    })
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("second")

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["target", "target"])
  })

  test("useKeymap can reactively enable layers with explicit keyed invalidation", async () => {
    const calls: string[] = []
    let setEnabled!: Dispatch<SetStateAction<boolean>>

    function App() {
      const manager = useKeymappings()
      const [enabled, setEnabledSignal] = useState(false)
      setEnabled = setEnabledSignal

      useEffect(() => {
        const offEnabled = registerEnabledField(manager)
        const offCommands = manager.registerCommands([
          {
            name: "reactive",
            run() {
              calls.push("reactive")
            },
          },
        ])

        return () => {
          offCommands()
          offEnabled()
        }
      }, [manager])

      useEffect(() => {
        manager.invalidateRuntimeKey("react.enabled")
      }, [enabled, manager])

      const layer = useMemo(
        () => ({
          scope: "global" as const,
          enabled: {
            match: () => enabled,
            keys: ["react.enabled"],
          },
          bindings: { x: "reactive" },
        }),
        [enabled],
      )

      useKeymap(layer)

      return <box width={20} height={6} />
    }

    testSetup = await testRender(<App />, { width: 20, height: 6 })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual([])

    act(() => {
      setEnabled(true)
    })
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["reactive"])

    act(() => {
      setEnabled(false)
    })
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["reactive"])
  })

  test("useKeymap shows an error for local bindings without a target or ref", async () => {
    const originalConsoleError = console.error
    console.error = () => {}

    try {
      function App() {
        useKeymap({
          scope: "focus-within",
          bindings: { x: "target" },
        })

        return <text>bindings</text>
      }

      testSetup = await testRender(<App />, {
        width: 140,
        height: 12,
      })
      await testSetup.renderOnce()

      const frame = testSetup.captureCharFrame()
      expect(frame).toContain(
        "useKeymap local bindings need a target or the returned ref callback attached to a renderable",
      )
    } finally {
      console.error = originalConsoleError
    }
  })

  test("useKeymap shows an error for explicit targets that are unavailable during mount", async () => {
    const originalConsoleError = console.error
    console.error = () => {}

    try {
      function App() {
        useKeymap({
          scope: "focus-within",
          target: () => undefined,
          bindings: { x: "target" },
        })

        return <text>bindings</text>
      }

      testSetup = await testRender(<App />, {
        width: 140,
        height: 12,
      })
      await testSetup.renderOnce()

      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("useKeymap target was not available during mount")
    } finally {
      console.error = originalConsoleError
    }
  })
})
