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
import { getKeymapManager, type KeymapLayer } from "@opentui/core/extras"
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

export interface UseKeymapLayer extends Omit<KeymapLayer, "target"> {
  target?: Renderable | null | undefined | (() => Renderable | null | undefined)
}

export type KeymapRef<TRenderable extends Renderable = Renderable> = (value: TRenderable) => void

function resolveKeymapTarget(target: UseKeymapLayer["target"]): Renderable | undefined {
  if (typeof target === "function") {
    return target() ?? undefined
  }

  return target ?? undefined
}

export const useKeymappings = () => {
  const renderer = useRenderer()
  return getKeymapManager(renderer)
}

export const useKeymap = <TRenderable extends Renderable = Renderable>(
  layer: UseKeymapLayer,
): KeymapRef<TRenderable> => {
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

    const resolvedLayer: KeymapLayer = {
      ...layer,
      scope: resolvedScope,
      target: resolvedTarget,
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
