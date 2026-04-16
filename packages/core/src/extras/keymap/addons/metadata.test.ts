import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../../../testing.js"
import { getKeymapManager } from "../index.js"
import { registerMetadataFields } from "./metadata.js"

let renderer: TestRenderer

describe("metadata addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
  })

  afterEach(() => {
    renderer?.destroy()
  })

  test("registers binding and command metadata fields", () => {
    const manager = getKeymapManager(renderer)
    registerMetadataFields(manager)

    manager.registerCommands([
      {
        name: "save-file",
        desc: "Save file",
        title: "Save",
        category: "File",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const activeKey = manager
      .getActiveKeys({ includeBindings: true })
      .find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.bindings?.[0]?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })
  })

  test("exposes generic binding and command metadata through includeMetadata", () => {
    const manager = getKeymapManager(renderer)
    registerMetadataFields(manager)

    manager.registerCommands([
      {
        name: "save-file",
        desc: "Save file",
        title: "Save",
        category: "File",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const activeKey = manager
      .getActiveKeys({ includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.bindings).toBeUndefined()
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.bindingAttrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })
  })

  test("can include both metadata and bindings", () => {
    const manager = getKeymapManager(renderer)
    registerMetadataFields(manager)

    manager.registerCommands([
      {
        name: "save-file",
        desc: "Save file",
        title: "Save",
        category: "File",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const activeKey = manager
      .getActiveKeys({ includeBindings: true, includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.bindingAttrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })
  })

  test("normalizes metadata strings and rejects invalid values", () => {
    const manager = getKeymapManager(renderer)
    const errors: string[] = []

    manager.on("error", (event) => {
      errors.push(event.message)
    })
    registerMetadataFields(manager)

    manager.registerCommands([
      {
        name: "save-file",
        desc: "  Save file  ",
        title: " Save ",
        category: " File ",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "  Write file  ", group: "  File  " }],
    })

    const activeKey = manager
      .getActiveKeys({ includeBindings: true })
      .find((candidate) => candidate.stroke.name === "x")
    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ desc: "Write file", group: "File" })
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.bindings?.[0]?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })

    expect(() => {
      manager.registerCommands([
        {
          name: "bad-command",
          desc: 123,
          run() {},
        },
      ])
    }).not.toThrow()

    expect(() => {
      manager.registerLayer({
        scope: "global",
        bindings: [{ key: "y", cmd: "save-file", group: "   " }],
      })
    }).not.toThrow()

    expect(errors).toEqual([
      'Keymap metadata field "desc" must be a string',
      'Keymap metadata field "group" cannot be empty',
    ])
    expect(manager.getCommands().some((command) => command.name === "bad-command")).toBe(false)
    expect(manager.getActiveKeys().some((candidate) => candidate.stroke.name === "y")).toBe(false)
  })

  test("can be disposed to stop compiling metadata fields", () => {
    const manager = getKeymapManager(renderer)
    const offMetadata = registerMetadataFields(manager)

    offMetadata()

    manager.registerCommands([
      {
        name: "save-file",
        desc: "Save file",
        title: "Save",
        category: "File",
        run() {},
      },
    ])

    manager.registerLayer({
      scope: "global",
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const activeKey = manager
      .getActiveKeys({ includeBindings: true, includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.bindingAttrs).toBeUndefined()
    expect(activeKey?.commandAttrs).toBeUndefined()
    expect(activeKey?.bindings?.[0]?.attrs).toBeUndefined()
    expect(activeKey?.bindings?.[0]?.commandAttrs).toBeUndefined()
  })
})
