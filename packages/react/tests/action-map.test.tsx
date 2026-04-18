import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { act } from "react"
import { addons, stringifyKeySequence } from "@opentui/core/extras"
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react"
import { testRender } from "../src/test-utils.js"
import {
  reactiveMatcherFromStore,
  useActionMap,
  useActiveKeys,
  useBindings,
  usePendingSequence,
} from "../src/index.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("React action map hooks", () => {
  beforeEach(async () => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  afterEach(() => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  test("useActionMap returns the renderer-scoped singleton", async () => {
    let first: ReturnType<typeof useActionMap> | undefined
    let second: ReturnType<typeof useActionMap> | undefined

    function Probe() {
      first = useActionMap()
      second = useActionMap()

      return <box width={10} height={4} />
    }

    await act(async () => {
      testSetup = await testRender(<Probe />, { width: 20, height: 6 })
    })

    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  test("useBindings registers global bindings and cleans them up on unmount", async () => {
    const calls: string[] = []
    let setVisible!: Dispatch<SetStateAction<boolean>>

    function GlobalBindings() {
      const manager = useActionMap()

      useEffect(() => {
        return manager.registerLayer({ scope: "global", commands: [
          {
            name: "global",
            run() {
              calls.push("global")
            },
          },
        ] })
      }, [manager])

      useBindings(
        () => ({
          scope: "global" as const,
          bindings: { x: "global" },
        }),
        [],
      )

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

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

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
      const manager = useActionMap()
      const activeKeys = useActiveKeys()

      useEffect(() => {
        return manager.registerLayer({ scope: "global", commands: [
          { name: "first", run() {} },
          { name: "second", run() {} },
        ] })
      }, [manager])

      const firstBindingsRef = useBindings(
        () => ({
          scope: "focus-within" as const,
          bindings: { x: "first" },
        }),
        [],
      )
      const secondBindingsRef = useBindings(
        () => ({
          scope: "focus-within" as const,
          bindings: { y: "second" },
        }),
        [],
      )

      return (
        <box width={24} height={8} flexDirection="column">
          <text>{`Active: ${activeKeys.map((key) => key.stroke.name).join(",") || "<none>"}`}</text>
          <box
            ref={(value) => {
              firstBindingsRef(value)
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
              secondBindingsRef(value)
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

    await act(async () => {
      testSetup = await testRender(<App />, { width: 24, height: 8 })
    })
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

  test("usePendingSequence updates without manual subscriptions", async () => {
    function App() {
      const manager = useActionMap()
      const pendingSequence = usePendingSequence()

      useEffect(() => {
        return manager.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
      }, [manager])

      useBindings(
        () => ({
          scope: "global" as const,
          bindings: [{ key: "dd", cmd: "delete-line" }],
        }),
        [],
      )

      return (
        <text>{`Pending: ${stringifyKeySequence(pendingSequence, { preferDisplay: true }) || "<root>"}`}</text>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 24, height: 6 })
    })
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

  test("useBindings can bind local bindings through its returned ref", async () => {
    const calls: string[] = []
    let setActive!: Dispatch<SetStateAction<"first" | "second">>

    function App() {
      const manager = useActionMap()
      const [active, setActiveSignal] = useState<"first" | "second">("first")
      setActive = setActiveSignal

      useEffect(() => {
        return manager.registerLayer({ scope: "global", commands: [
          {
            name: "target",
            run() {
              calls.push("target")
            },
          },
        ] })
      }, [manager])

      const bindingsRef = useBindings(
        () => ({
          scope: "focus-within" as const,
          bindings: [{ key: "x", cmd: "target" }],
        }),
        [],
      )

      return (
        <box width={20} height={6}>
          <box ref={bindingsRef} width={8} height={3} focusable focused={active === "first"} />
          <box width={8} height={3} focusable focused={active === "second"} />
        </box>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

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

  test("useBindings follows a stable ref when it retargets to a new renderable", async () => {
    const calls: string[] = []
    let setActive!: Dispatch<SetStateAction<"first" | "second">>

    function App() {
      const manager = useActionMap()
      const [active, setActiveSignal] = useState<"first" | "second">("first")
      setActive = setActiveSignal

      useEffect(() => {
        return manager.registerLayer({ scope: "global", commands: [
          {
            name: "target",
            run() {
              calls.push("target")
            },
          },
        ] })
      }, [manager])

      const bindingsRef = useBindings(
        () => ({
          scope: "focus-within" as const,
          bindings: [{ key: "x", cmd: "target" }],
        }),
        [],
      )

      return (
        <box width={20} height={6}>
          {active === "first" ? (
            <box key="first" id="first" ref={bindingsRef} width={8} height={3} focusable focused />
          ) : (
            <box key="second" id="second" ref={bindingsRef} width={8} height={3} focusable focused />
          )}
        </box>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })
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

  test("useBindings can reactively enable layers via reactiveMatcherFromStore", async () => {
    const calls: string[] = []

    const createEnabledStore = () => {
      let enabled = false
      const listeners = new Set<() => void>()
      return {
        getSnapshot: () => enabled,
        subscribe: (onChange: () => void) => {
          listeners.add(onChange)
          return () => listeners.delete(onChange)
        },
        set(next: boolean) {
          if (enabled === next) return
          enabled = next
          for (const fn of listeners) fn()
        },
      }
    }

    const store = createEnabledStore()

    function App() {
      const manager = useActionMap()

      useEffect(() => {
        const offEnabled = addons.registerEnabledField(manager)
        const offCommands = manager.registerLayer({ scope: "global", commands: [
          {
            name: "reactive",
            run() {
              calls.push("reactive")
            },
          },
        ] })

        return () => {
          offCommands()
          offEnabled()
        }
      }, [manager])

      const matcher = useMemo(() => reactiveMatcherFromStore(store.subscribe, store.getSnapshot), [])

      useBindings(
        () => ({
          scope: "global" as const,
          enabled: matcher,
          bindings: { x: "reactive" },
        }),
        [matcher],
      )

      return <box width={20} height={6} />
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual([])

    act(() => {
      store.set(true)
    })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["reactive"])

    act(() => {
      store.set(false)
    })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["reactive"])
  })

  test("reactiveMatcherFromStore: applies predicate when snapshot is not boolean", async () => {
    const calls: string[] = []

    const createModeStore = () => {
      let mode: "normal" | "visual" = "visual"
      const listeners = new Set<() => void>()
      return {
        getSnapshot: () => mode,
        subscribe: (onChange: () => void) => {
          listeners.add(onChange)
          return () => listeners.delete(onChange)
        },
        set(next: "normal" | "visual") {
          if (mode === next) return
          mode = next
          for (const fn of listeners) fn()
        },
      }
    }

    const store = createModeStore()

    function App() {
      const manager = useActionMap()

      useEffect(() => {
        const offEnabled = addons.registerEnabledField(manager)
        const offCommands = manager.registerLayer({ scope: "global", commands: [
          {
            name: "normal-only",
            run() {
              calls.push("normal")
            },
          },
        ] })
        return () => {
          offCommands()
          offEnabled()
        }
      }, [manager])

      const matcher = useMemo(
        () => reactiveMatcherFromStore(store.subscribe, store.getSnapshot, (mode) => mode === "normal"),
        [],
      )

      useBindings(
        () => ({ scope: "global" as const, enabled: matcher, bindings: { x: "normal-only" } }),
        [matcher],
      )

      return <box width={20} height={6} />
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    act(() => testSetup.mockInput.pressKey("x"))
    expect(calls).toEqual([])

    act(() => store.set("normal"))
    act(() => testSetup.mockInput.pressKey("x"))
    expect(calls).toEqual(["normal"])

    act(() => store.set("visual"))
    act(() => testSetup.mockInput.pressKey("x"))
    expect(calls).toEqual(["normal"])
  })

  test("reactiveMatcherFromStore: unsubscribes from store on layer unregister", async () => {
    let listenerCount = 0
    const storeListeners = new Set<() => void>()
    const store = {
      getSnapshot: () => false,
      subscribe(onChange: () => void) {
        listenerCount += 1
        storeListeners.add(onChange)
        return () => {
          listenerCount -= 1
          storeListeners.delete(onChange)
        }
      },
    }

    let setMounted!: Dispatch<SetStateAction<boolean>>

    function Child() {
      const matcher = useMemo(() => reactiveMatcherFromStore(store.subscribe, store.getSnapshot), [])
      useBindings(() => ({ scope: "global", enabled: matcher, bindings: { x: "probe" } }), [matcher])
      return <box width={10} height={2} />
    }

    function App() {
      const [mounted, setter] = useState(true)
      setMounted = setter

      const manager = useActionMap()

      // Install these before the child's `useBindings` effect runs.
      useMemo(() => {
        addons.registerEnabledField(manager)
        manager.registerLayer({ scope: "global", commands: [{ name: "probe", run() {} }] })
      }, [manager])

      return <>{mounted ? <Child /> : null}</>
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    expect(listenerCount).toBe(1)

    act(() => {
      setMounted(false)
    })

    expect(listenerCount).toBe(0)
    expect(storeListeners.size).toBe(0)
  })

  test("useBindings shows an error for local bindings without a target or ref", async () => {
    const originalConsoleError = console.error
    console.error = () => {}

    try {
      function App() {
        useBindings(
          () => ({
            scope: "focus-within",
            bindings: { x: "target" },
          }),
          [],
        )

        return <text>bindings</text>
      }

      await act(async () => {
        testSetup = await testRender(<App />, {
          width: 140,
          height: 12,
        })
      })
      await testSetup.renderOnce()

      const frame = testSetup.captureCharFrame()
      expect(frame).toContain(
        "useBindings local bindings need a target or the returned ref callback attached to a renderable",
      )
    } finally {
      console.error = originalConsoleError
    }
  })

  test("useBindings shows an error for explicit targets that are unavailable during mount", async () => {
    const originalConsoleError = console.error
    console.error = () => {}

    try {
      function App() {
        useBindings(
          () => ({
            scope: "focus-within",
            target: () => undefined,
            bindings: { x: "target" },
          }),
          [],
        )

        return <text>bindings</text>
      }

      await act(async () => {
        testSetup = await testRender(<App />, {
          width: 140,
          height: 12,
        })
      })
      await testSetup.renderOnce()

      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("useBindings target was not available during mount")
    } finally {
      console.error = originalConsoleError
    }
  })
})
