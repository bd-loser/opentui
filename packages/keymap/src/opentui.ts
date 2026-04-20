import { CliRenderEvents, KeyEvent, RenderableEvents, type CliRenderer, type Renderable } from "@opentui/core"
import { registerDefaultKeys } from "./addons/universal/default-parser.js"
import { Keymap } from "./keymap.js"
import type { KeymapHost } from "./types.js"

export * from "./core.js"
export * as addons from "./addons/opentui/index.js"

const keymapsByRenderer = new WeakMap<CliRenderer, Keymap<Renderable, KeyEvent>>()

function createSyntheticCommandEvent(): KeyEvent {
  return new KeyEvent({
    name: "command",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
  })
}

export function createOpenTuiKeymapHost(renderer: CliRenderer): KeymapHost<Renderable, KeyEvent> {
  return {
    rootTarget: renderer.root,
    get isDestroyed() {
      return renderer.isDestroyed
    },
    getFocusedTarget() {
      const focused = renderer.currentFocusedRenderable
      if (!focused || focused.isDestroyed || !focused.focused) {
        return null
      }

      return focused
    },
    getParentTarget(target) {
      return target.parent
    },
    isTargetDestroyed(target) {
      return target.isDestroyed
    },
    onKeyPress(listener) {
      renderer.keyInput.prependListener("keypress", listener)
      return () => {
        renderer.keyInput.off("keypress", listener)
      }
    },
    onKeyRelease(listener) {
      renderer.keyInput.prependListener("keyrelease", listener)
      return () => {
        renderer.keyInput.off("keyrelease", listener)
      }
    },
    onFocusChange(listener) {
      renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, listener)
      return () => {
        renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, listener)
      }
    },
    onDestroy(listener) {
      renderer.once(CliRenderEvents.DESTROY, listener)
      return () => {
        renderer.off(CliRenderEvents.DESTROY, listener)
      }
    },
    onTargetDestroy(target, listener) {
      target.once(RenderableEvents.DESTROYED, listener)
      return () => {
        target.off(RenderableEvents.DESTROYED, listener)
      }
    },
    onRawInput(listener) {
      renderer.prependInputHandler(listener)
      return () => {
        renderer.removeInputHandler(listener)
      }
    },
    createCommandEvent() {
      return createSyntheticCommandEvent()
    },
  }
}

export function getKeymap(renderer: CliRenderer): Keymap<Renderable, KeyEvent> {
  if (renderer.isDestroyed) {
    throw new Error("Cannot create a keymap for a destroyed renderer")
  }

  const existing = keymapsByRenderer.get(renderer)
  if (existing) {
    return existing
  }

  const keymap = new Keymap(createOpenTuiKeymapHost(renderer))
  registerDefaultKeys(keymap)
  keymapsByRenderer.set(renderer, keymap)

  renderer.once(CliRenderEvents.DESTROY, () => {
    keymapsByRenderer.delete(renderer)
  })

  return keymap
}
