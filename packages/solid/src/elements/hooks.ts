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
import {
  getActionMap,
  type ActionMapActiveKey,
  type ActionMapActiveKeyOptions,
  type ActionMapLayer,
  type ActionMapLayerFields,
  type ActionMap,
  type ActionMapReactiveMatcher,
  type ParsedKeyPart,
} from "@opentui/core/extras"
import {
  createContext,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  on,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
} from "solid-js"

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

export type UseBindingsTarget<TRenderable extends Renderable = Renderable> =
  | TRenderable
  | null
  | undefined
  | (() => TRenderable | null | undefined)

type UseBindingsLayerBase = ActionMapLayerFields

export type BindingsRef<TRenderable extends Renderable = Renderable> = (value: TRenderable) => void

export interface UseGlobalBindingsLayer extends UseBindingsLayerBase {
  scope?: "global"
  target?: undefined
}

export interface UseFocusBindingsLayer<TRenderable extends Renderable = Renderable> extends UseBindingsLayerBase {
  scope: "focus"
  target?: UseBindingsTarget<TRenderable>
}

export interface UseFocusWithinBindingsLayer<TRenderable extends Renderable = Renderable> extends UseBindingsLayerBase {
  scope: "focus-within"
  target?: UseBindingsTarget<TRenderable>
}

export interface UseInferredFocusWithinBindingsLayer<
  TRenderable extends Renderable = Renderable,
> extends UseBindingsLayerBase {
  scope?: undefined
  target: UseBindingsTarget<TRenderable>
}

export type UseTargetBindingsLayer<TRenderable extends Renderable = Renderable> =
  | UseFocusBindingsLayer<TRenderable>
  | UseFocusWithinBindingsLayer<TRenderable>
  | UseInferredFocusWithinBindingsLayer<TRenderable>

export type UseBindingsLayer<TRenderable extends Renderable = Renderable> =
  | UseGlobalBindingsLayer
  | UseTargetBindingsLayer<TRenderable>

function resolveBindingsTarget(target: UseBindingsTarget | undefined): Renderable | undefined {
  if (typeof target === "function") {
    return target() ?? undefined
  }

  return target ?? undefined
}

export const useActionMap = (): ActionMap => {
  const renderer = useRenderer()
  return getActionMap(renderer)
}

// Use the batched `state` hook for derived reads. Pending-sequence changes
// already flow through `state`, so subscribing to both would duplicate work.
function useActionMapStateVersion(manager: ActionMap): Accessor<number> {
  const [version, setVersion] = createSignal(0)
  let dispose: (() => void) | undefined

  onMount(() => {
    dispose = manager.hook("state", () => {
      setVersion((value) => value + 1)
    })

    setVersion((value) => value + 1)
  })

  onCleanup(() => {
    dispose?.()
  })

  return version
}

export const useActiveKeys = (options?: ActionMapActiveKeyOptions): Accessor<readonly ActionMapActiveKey[]> => {
  const manager = useActionMap()
  const version = useActionMapStateVersion(manager)

  return createMemo(() => {
    version()
    return manager.getActiveKeys(options)
  })
}

export const usePendingSequenceParts = (): Accessor<readonly ParsedKeyPart[]> => {
  const manager = useActionMap()
  const version = useActionMapStateVersion(manager)

  return createMemo(() => {
    version()
    return manager.getPendingSequenceParts()
  })
}

export function useBindings<TRenderable extends Renderable = Renderable>(
  layer: UseGlobalBindingsLayer,
): BindingsRef<TRenderable>
export function useBindings<TRenderable extends Renderable = Renderable>(
  layer: UseTargetBindingsLayer<TRenderable>,
): BindingsRef<TRenderable>
export function useBindings<TRenderable extends Renderable = Renderable>(
  layer: UseBindingsLayer<TRenderable>,
): BindingsRef<TRenderable> {
  const manager = useActionMap()
  let dispose: (() => void) | undefined
  let mounted = false
  let registered = false
  let registeredScope: ActionMapLayer["scope"] | undefined
  let refTarget: Renderable | undefined

  const register = (): void => {
    if (registered) {
      return
    }

    const explicitTarget = resolveBindingsTarget(layer.target)
    const resolvedTarget = explicitTarget ?? refTarget
    const resolvedScope = layer.scope ?? (resolvedTarget ? "focus-within" : "global")

    if (resolvedScope !== "global" && !resolvedTarget) {
      return
    }

    const { scope: _scope, target: _target, ...baseLayer } = layer

    let resolvedLayer: ActionMapLayer
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

  const ref: BindingsRef<TRenderable> = (value) => {
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
    const resolvedTarget = resolveBindingsTarget(layer.target)
    if (layer.target !== undefined && !resolvedTarget) {
      throw new Error("useBindings target was not available during mount")
    }

    const resolvedScope = layer.scope ?? (resolvedTarget || refTarget ? "focus-within" : "global")
    if (resolvedScope !== "global" && !resolvedTarget && !refTarget) {
      throw new Error("useBindings local bindings need a target or the returned ref callback attached to a renderable")
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
 * Adapts a Solid accessor to `ActionMapReactiveMatcher`. The subscription
 * lives in a disposable reactive root so unregistering the layer tears it
 * down. Pass `predicate` when the accessor value is not already boolean.
 */
export function reactiveMatcherFromSignal<T>(
  accessor: Accessor<T>,
  predicate?: (value: T) => boolean,
): ActionMapReactiveMatcher {
  return {
    get() {
      return predicate ? predicate(accessor()) : Boolean(accessor())
    },
    subscribe(onChange) {
      return createRoot((dispose) => {
        createEffect(on(accessor, () => onChange(), { defer: true }))
        return dispose
      })
    },
  }
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
