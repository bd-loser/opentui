import {
  engine,
  PasteEvent,
  type Renderable,
  Selection,
  Timeline,
  type CliRenderer,
  type KeyEvent,
  type TimelineOptions,
} from "@opentui/core"
import { getKeymapManager, type KeymapLayer, type KeymapLayerFields } from "@opentui/core/extras"
import { createContext, createSignal, onCleanup, onMount, useContext } from "solid-js"

export const RendererContext = createContext<CliRenderer>()

export const useRenderer = () => {
  const renderer = useContext(RendererContext)

  if (!renderer) {
    throw new Error("No renderer found")
  }

  return renderer
}

export const onResize = (callback: (width: number, height: number) => void) => {
  const renderer = useRenderer()

  onMount(() => {
    renderer.on("resize", callback)
  })

  onCleanup(() => {
    renderer.off("resize", callback)
  })
}

export const useTerminalDimensions = () => {
  const renderer = useRenderer()
  const [terminalDimensions, setTerminalDimensions] = createSignal<{
    width: number
    height: number
  }>({ width: renderer.width, height: renderer.height })

  const callback = (width: number, height: number) => {
    setTerminalDimensions({ width, height })
  }

  onResize(callback)

  return terminalDimensions
}

export interface UseKeyboardOptions {
  /** Include release events - callback receives events with eventType: "release" */
  release?: boolean
}

/**
 * Subscribe to keyboard events.
 *
 * By default, only receives press events (including key repeats with `repeated: true`).
 * Use `options.release` to also receive release events.
 *
 * @example
 * // Basic press handling (includes repeats)
 * useKeyboard((e) => console.log(e.name, e.repeated ? "(repeat)" : ""))
 *
 * // With release events
 * useKeyboard((e) => {
 *   if (e.eventType === "release") keys.delete(e.name)
 *   else keys.add(e.name)
 * }, { release: true })
 */
export const useKeyboard = (callback: (key: KeyEvent) => void, options?: UseKeyboardOptions) => {
  const renderer = useRenderer()
  const keyHandler = renderer.keyInput
  onMount(() => {
    keyHandler.on("keypress", callback)
    if (options?.release) {
      keyHandler.on("keyrelease", callback)
    }
  })

  onCleanup(() => {
    keyHandler.off("keypress", callback)
    if (options?.release) {
      keyHandler.off("keyrelease", callback)
    }
  })
}

export const usePaste = (callback: (event: PasteEvent) => void) => {
  const renderer = useRenderer()
  const keyHandler = renderer.keyInput
  onMount(() => {
    keyHandler.on("paste", callback)
  })

  onCleanup(() => {
    keyHandler.off("paste", callback)
  })
}

export type UseKeymapTarget<TRenderable extends Renderable = Renderable> =
  | TRenderable
  | null
  | undefined
  | (() => TRenderable | null | undefined)

type UseKeymapLayerBase = KeymapLayerFields

export type KeymapRef<TRenderable extends Renderable = Renderable> = (value: TRenderable) => void

export interface UseGlobalKeymapLayer extends UseKeymapLayerBase {
  scope?: "global"
  target?: undefined
}

export interface UseFocusKeymapLayer<TRenderable extends Renderable = Renderable> extends UseKeymapLayerBase {
  scope: "focus"
  target?: UseKeymapTarget<TRenderable>
}

export interface UseFocusWithinKeymapLayer<TRenderable extends Renderable = Renderable> extends UseKeymapLayerBase {
  scope: "focus-within"
  target?: UseKeymapTarget<TRenderable>
}

export interface UseInferredFocusWithinKeymapLayer<TRenderable extends Renderable = Renderable>
  extends UseKeymapLayerBase {
  scope?: undefined
  target: UseKeymapTarget<TRenderable>
}

export type UseTargetKeymapLayer<TRenderable extends Renderable = Renderable> =
  | UseFocusKeymapLayer<TRenderable>
  | UseFocusWithinKeymapLayer<TRenderable>
  | UseInferredFocusWithinKeymapLayer<TRenderable>

export type UseKeymapLayer<TRenderable extends Renderable = Renderable> =
  | UseGlobalKeymapLayer
  | UseTargetKeymapLayer<TRenderable>

function resolveKeymapTarget(target: UseKeymapTarget | undefined): Renderable | undefined {
  if (typeof target === "function") {
    return target() ?? undefined
  }

  return target ?? undefined
}

export const useKeymappings = () => {
  const renderer = useRenderer()
  return getKeymapManager(renderer)
}

export function useKeymap<TRenderable extends Renderable = Renderable>(layer: UseGlobalKeymapLayer): KeymapRef<TRenderable>
export function useKeymap<TRenderable extends Renderable = Renderable>(
  layer: UseTargetKeymapLayer<TRenderable>,
): KeymapRef<TRenderable>
export function useKeymap<TRenderable extends Renderable = Renderable>(
  layer: UseKeymapLayer<TRenderable>,
): KeymapRef<TRenderable> {
  const manager = useKeymappings()
  let dispose: (() => void) | undefined
  let mounted = false
  let registered = false
  let registeredScope: KeymapLayer["scope"] | undefined
  let refTarget: Renderable | undefined

  const register = (): void => {
    if (registered) {
      return
    }

    const explicitTarget = resolveKeymapTarget(layer.target)
    const resolvedTarget = explicitTarget ?? refTarget
    const resolvedScope = layer.scope ?? (resolvedTarget ? "focus-within" : "global")

    if (resolvedScope !== "global" && !resolvedTarget) {
      return
    }

    const { scope: _scope, target: _target, ...baseLayer } = layer

    let resolvedLayer: KeymapLayer
    if (resolvedScope === "global") {
      resolvedLayer = {
        ...baseLayer,
        scope: "global",
      }
    } else {
      if (!resolvedTarget) {
        return
      }

      resolvedLayer = {
        ...baseLayer,
        scope: resolvedScope,
        target: resolvedTarget,
      }
    }

    dispose = manager.registerLayer(resolvedLayer)
    registered = true
    registeredScope = resolvedScope
  }

  const ref: KeymapRef<TRenderable> = (value) => {
    refTarget = value

    if (mounted) {
      if (registered && layer.target === undefined && layer.scope === undefined && registeredScope === "global") {
        dispose?.()
        dispose = undefined
        registered = false
        registeredScope = undefined
      }

      register()
    }
  }

  onMount(() => {
    mounted = true
    const resolvedTarget = resolveKeymapTarget(layer.target)
    if (layer.target !== undefined && !resolvedTarget) {
      throw new Error("useKeymap target was not available during mount")
    }

    const resolvedScope = layer.scope ?? (resolvedTarget || refTarget ? "focus-within" : "global")
    if (resolvedScope !== "global" && !resolvedTarget && !refTarget) {
      throw new Error("useKeymap local bindings need a target or the returned ref callback attached to a renderable")
    }

    register()
  })

  onCleanup(() => {
    dispose?.()
    dispose = undefined
    mounted = false
    registered = false
    registeredScope = undefined
  })

  return ref
}

/**
 * @deprecated renamed to useKeyboard
 */
export const useKeyHandler = useKeyboard

export const onFocus = (callback: () => void) => {
  const renderer = useRenderer()

  onMount(() => {
    renderer.on("focus", callback)
  })

  onCleanup(() => {
    renderer.off("focus", callback)
  })
}

export const onBlur = (callback: () => void) => {
  const renderer = useRenderer()

  onMount(() => {
    renderer.on("blur", callback)
  })

  onCleanup(() => {
    renderer.off("blur", callback)
  })
}

export const useSelectionHandler = (callback: (selection: Selection) => void) => {
  const renderer = useRenderer()

  onMount(() => {
    renderer.on("selection", callback)
  })

  onCleanup(() => {
    renderer.off("selection", callback)
  })
}

export const useTimeline = (options: TimelineOptions = {}): Timeline => {
  const timeline = new Timeline(options)

  onMount(() => {
    if (options.autoplay !== false) {
      timeline.play()
    }
    engine.register(timeline)
  })

  onCleanup(() => {
    timeline.pause()
    engine.unregister(timeline)
  })

  return timeline
}
