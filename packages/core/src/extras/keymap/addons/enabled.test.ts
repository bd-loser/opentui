import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymap } from "../index.js"
import { registerEnabledField } from "./enabled.js"

let renderer: TestRenderer
let mockInput: MockInput

function getActiveKeyNames(): string[] {
  return getKeymap(renderer)
    .getActiveKeys()
    .map((candidate) => candidate.stroke.name)
    .sort()
}

describe("enabled addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("ignores enabled layer fields until the addon is registered", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "noop",
          run() {
            calls.push("noop")
          },
        },
      ],
    })

    expect(() => {
      keymap.registerLayer({
        scope: "global",
        enabled: false,
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames()).toEqual(["x"])

    mockInput.pressKey("x")

    expect(calls).toEqual(["noop"])
  })

  test("registers boolean and predicate enabled values", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    let enabled = false

    registerEnabledField(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "always-off",
          run() {
            calls.push("always-off")
          },
        },
        {
          name: "dynamic",
          run() {
            calls.push("dynamic")
          },
        },
      ],
    })

    keymap.registerLayer({
      scope: "global",
      enabled: false,
      bindings: [{ key: "x", cmd: "always-off" }],
    })
    keymap.registerLayer({
      scope: "global",
      enabled: () => enabled,
      bindings: [{ key: "y", cmd: "dynamic" }],
    })

    expect(getActiveKeyNames()).toEqual([])

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual([])

    enabled = true

    expect(getActiveKeyNames()).toEqual(["y"])

    mockInput.pressKey("y")

    expect(calls).toEqual(["dynamic"])
  })

  test("supports reactive enabled matchers and unsubscribes on layer unregister", () => {
    const keymap = getKeymap(renderer)
    let current = false
    const listeners = new Set<() => void>()
    let evaluations = 0
    let subscribeCalls = 0
    let disposeCalls = 0

    const enabledMatcher = {
      get() {
        evaluations += 1
        return current
      },
      subscribe(onChange: () => void) {
        subscribeCalls += 1
        listeners.add(onChange)
        return () => {
          disposeCalls += 1
          listeners.delete(onChange)
        }
      },
    }

    const setEnabled = (next: boolean) => {
      if (current === next) {
        return
      }
      current = next
      for (const fn of listeners) {
        fn()
      }
    }

    registerEnabledField(keymap)
    keymap.registerLayer({ scope: "global", commands: [{ name: "dynamic", run() {} }] })
    const off = keymap.registerLayer({
      scope: "global",
      enabled: enabledMatcher,
      bindings: [{ key: "y", cmd: "dynamic" }],
    })

    expect(subscribeCalls).toBe(1)
    expect(listeners.size).toBe(1)

    expect(getActiveKeyNames()).toEqual([])
    expect(evaluations).toBe(1)

    current = true
    expect(getActiveKeyNames()).toEqual([])
    expect(evaluations).toBe(1)
    current = false

    setEnabled(true)
    expect(getActiveKeyNames()).toEqual(["y"])
    expect(evaluations).toBe(2)

    setEnabled(false)
    expect(getActiveKeyNames()).toEqual([])
    expect(evaluations).toBe(3)

    off()
    expect(disposeCalls).toBe(1)
    expect(listeners.size).toBe(0)
  })

  test("clears pending sequences when enabled stops matching", () => {
    const keymap = getKeymap(renderer)
    let enabled = true

    registerEnabledField(keymap)
    keymap.registerLayer({ scope: "global", commands: [{ name: "delete-line", run() {} }] })
    keymap.registerLayer({
      scope: "global",
      enabled: () => enabled,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(keymap.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(keymap.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames()).toEqual([])
  })

  test("rejects invalid enabled values and can be disposed", () => {
    const keymap = getKeymap(renderer)
    const offEnabled = registerEnabledField(keymap)
    const calls: string[] = []
    const errors: string[] = []

    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "noop",
          run() {
            calls.push("noop")
          },
        },
      ],
    })

    expect(() => {
      keymap.registerLayer({
        scope: "global",
        enabled: "yes",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(errors).toEqual(['Keymap enabled field "enabled" must be a boolean, a function, or a reactive matcher'])
    expect(getActiveKeyNames()).toEqual([])

    offEnabled()

    expect(() => {
      keymap.registerLayer({
        scope: "global",
        enabled: true,
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKeyNames()).toContain("x")

    mockInput.pressKey("x")

    expect(calls).toEqual(["noop"])
  })

  test("treats thrown enabled predicates as disabled", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    registerEnabledField(keymap)
    keymap.registerLayer({
      scope: "global",
      commands: [
        {
          name: "noop",
          run() {
            calls.push("noop")
          },
        },
      ],
    })
    keymap.registerLayer({
      scope: "global",
      enabled: () => {
        throw new Error("boom")
      },
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(() => keymap.getActiveKeys()).not.toThrow()
    expect(getActiveKeyNames()).toEqual([])

    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })
})
