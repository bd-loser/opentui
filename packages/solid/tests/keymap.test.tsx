import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import * as addons from "@opentui/keymap/addons"
import { stringifyKeySequence } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, useBindings } from "@opentui/keymap/solid"
import { render } from "../index.js"
import { Show, createSignal } from "solid-js"

let testSetup: Awaited<ReturnType<typeof createTestRenderer>>

describe("Solid keymap integration", () => {
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

  test("timed leader exposes root and mounted dialog continuations together", async () => {
    const calls: string[] = []
    let setDialogOpen!: (value: boolean) => void

    let offLeader: (() => void) | undefined
    testSetup = await createTestRenderer({
      width: 80,
      height: 10,
      onDestroy() {
        offLeader?.()
      },
    })

    const keymap = createDefaultOpenTuiKeymap(testSetup.renderer)
    offLeader = addons.registerTimedLeader(keymap, {
      trigger: { name: "x", ctrl: true },
      timeoutMs: 1_000,
    })

    function Dialog() {
      const [target, setTarget] = createSignal<Renderable | undefined>(undefined)

      useBindings<Renderable>(() => ({
        scope: "focus-within",
        target,
        commands: [
          {
            name: "dialog-delete",
            run() {
              calls.push("dialog-delete")
            },
          },
          {
            name: "dialog-write",
            run() {
              calls.push("dialog-write")
            },
          },
        ],
        bindings: [
          { key: "<leader>d", cmd: "dialog-delete", desc: "dialog-delete" },
          { key: "<leader>w", cmd: "dialog-write", desc: "dialog-write" },
        ],
      }))

      return (
        <box
          id="dialog"
          ref={setTarget}
          width={24}
          height={3}
          focusable
          border
        />
      )
    }

    function App() {
      const [dialogOpen, setDialogOpenSignal] = createSignal(true)
      setDialogOpen = setDialogOpenSignal

      useBindings(() => ({
        scope: "global",
        commands: [
          {
            name: "root-refresh",
            run() {
              calls.push("root-refresh")
            },
          },
          {
            name: "root-save",
            run() {
              calls.push("root-save")
            },
          },
        ],
        bindings: [
          { key: "<leader>r", cmd: "root-refresh", desc: "root-refresh" },
          { key: "<leader>s", cmd: "root-save", desc: "root-save" },
        ],
      }))

      return (
        <box width={80} height={10} flexDirection="column">
          <text>{`Dialog: ${dialogOpen() ? "open" : "closed"}`}</text>
          <Show when={dialogOpen()}>{() => <Dialog />}</Show>
        </box>
      )
    }

    await render(
      () => (
        <KeymapProvider keymap={keymap}>
          <App />
        </KeymapProvider>
      ),
      testSetup.renderer,
    )

    const flush = async () => {
      await Bun.sleep(0)
      await testSetup.renderOnce()
    }
    const getPending = () => stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true }) || "<root>"
    const getActive = () => {
      return (
        keymap
          .getActiveKeys({ includeMetadata: true })
          .map((activeKey) => `${activeKey.display}=${String(activeKey.bindingAttrs?.desc ?? activeKey.command ?? "")}`)
          .sort()
          .join(",") || "<none>"
      )
    }

    await flush()
    let frame = testSetup.captureCharFrame()
    expect(frame).toContain("Dialog: open")
    expect(getPending()).toBe("<root>")

    testSetup.renderer.root.findDescendantById("dialog")?.focus()
    await flush()

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    expect(getPending()).toBe("<leader>")
    expect(getActive()).toBe("d=dialog-delete,r=root-refresh,s=root-save,w=dialog-write")

    testSetup.mockInput.pressKey("r")
    await flush()
    expect(getPending()).toBe("<root>")
    expect(calls).toEqual(["root-refresh"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("w")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("d")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete"])

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    testSetup.mockInput.pressKey("s")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete", "root-save"])

    setDialogOpen(false)
    await flush()
    frame = testSetup.captureCharFrame()
    expect(frame).toContain("Dialog: closed")

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()
    expect(getPending()).toBe("<leader>")
    expect(getActive()).toBe("r=root-refresh,s=root-save")

    testSetup.mockInput.pressKey("w")
    await flush()
    expect(calls).toEqual(["root-refresh", "dialog-write", "dialog-delete", "root-save"])
  })
})
