import { CliRenderEvents, KeyEvent, RenderableEvents, type CliRenderer, type Renderable } from "@opentui/core"
import { registerDefaultKeys } from "./addons/universal/default-parser.js"
import { registerEnabledFields } from "./addons/universal/enabled.js"
import { registerMetadataFields } from "./addons/universal/metadata.js"
import { Keymap } from "./keymap.js"
import type { KeymapHost } from "./types.js"

export * from "./index.js"

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

export function createOpenTuiKeymap(renderer: CliRenderer): Keymap<Renderable, KeyEvent> {
  if (renderer.isDestroyed) {
    throw new Error("Cannot create a keymap for a destroyed renderer")
  }

  return new Keymap(createOpenTuiKeymapHost(renderer))
}

export function createDefaultOpenTuiKeymap(renderer: CliRenderer): Keymap<Renderable, KeyEvent> {
  const keymap = createOpenTuiKeymap(renderer)
  registerDefaultKeys(keymap)
  registerEnabledFields(keymap)
  registerMetadataFields(keymap)
  return keymap
}
