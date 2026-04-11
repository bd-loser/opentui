import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type MockInput, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { registerEnabledField } from "./enabled.js"

let renderer: TestRenderer
let mockInput: MockInput

function getActiveKeyNames(): string[] {
  return getKeymapManager(renderer)
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
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "noop",
        run() {
          calls.push("noop")
        },
      },
    ])

    expect(() => {
      manager.registerLayer({
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
    const manager = getKeymapManager(renderer)
    const calls: string[] = []
    let enabled = false

    registerEnabledField(manager)
    manager.registerCommands([
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
    ])

    manager.registerLayer({
      scope: "global",
      enabled: false,
      bindings: [{ key: "x", cmd: "always-off" }],
    })
    manager.registerLayer({
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

  test("supports keyed enabled matchers with explicit invalidation", () => {
    const manager = getKeymapManager(renderer)
    let enabled = false
    let evaluations = 0

    registerEnabledField(manager)
    manager.registerCommands([{ name: "dynamic", run() {} }])
    manager.registerLayer({
      scope: "global",
      enabled: {
        match: () => {
          evaluations += 1
          return enabled
        },
        keys: ["layer.enabled"],
      },
      bindings: [{ key: "y", cmd: "dynamic" }],
    })

    expect(getActiveKeyNames()).toEqual([])
    expect(evaluations).toBe(1)

    enabled = true

    expect(getActiveKeyNames()).toEqual([])
    expect(evaluations).toBe(1)

    manager.invalidateRuntimeKey("layer.enabled")

    expect(getActiveKeyNames()).toEqual(["y"])
    expect(evaluations).toBe(2)

    enabled = false

    expect(getActiveKeyNames()).toEqual(["y"])

    manager.invalidateRuntimeKey("layer.enabled")

    expect(getActiveKeyNames()).toEqual([])
    expect(evaluations).toBe(3)
  })

  test("clears pending sequences when enabled stops matching", () => {
    const manager = getKeymapManager(renderer)
    let enabled = true

    registerEnabledField(manager)
    manager.registerCommands([{ name: "delete-line", run() {} }])
    manager.registerLayer({
      scope: "global",
      enabled: () => enabled,
      bindings: [{ key: "dd", cmd: "delete-line" }],
    })

    mockInput.pressKey("d")

    expect(manager.getPendingSequence()).toHaveLength(1)

    enabled = false

    expect(manager.getPendingSequence()).toEqual([])
    expect(getActiveKeyNames()).toEqual([])
  })

  test("rejects invalid enabled values and can be disposed", () => {
    const manager = getKeymapManager(renderer)
    const offEnabled = registerEnabledField(manager)
    const calls: string[] = []

    manager.registerCommands([
      {
        name: "noop",
        run() {
          calls.push("noop")
        },
      },
    ])

    expect(() => {
      manager.registerLayer({
        scope: "global",
        enabled: "yes",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).toThrow('Keymap enabled field "enabled" must be a boolean, function, or { match, keys } object')

    offEnabled()

    expect(() => {
      manager.registerLayer({
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
    const manager = getKeymapManager(renderer)
    const calls: string[] = []

    registerEnabledField(manager)
    manager.registerCommands([
      {
        name: "noop",
        run() {
          calls.push("noop")
        },
      },
    ])
    manager.registerLayer({
      scope: "global",
      enabled: () => {
        throw new Error("boom")
      },
      bindings: [{ key: "x", cmd: "noop" }],
    })

    expect(() => manager.getActiveKeys()).not.toThrow()
    expect(getActiveKeyNames()).toEqual([])

    mockInput.pressKey("x")

    expect(calls).toEqual([])
  })
})
