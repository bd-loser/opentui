import type { Renderable } from "@opentui/core"
import {
  getKeymap,
  type ActiveKey,
  type ActiveKeyOptions,
  type Keymap,
  type KeySequencePart,
  type Layer,
  type LayerFields,
  type ReactiveMatcher,
} from "../index.js"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js"

export type UseBindingsTarget<TRenderable extends Renderable = Renderable> =
  | TRenderable
  | null
  | undefined
  | (() => TRenderable | null | undefined)

type UseBindingsLayerBase = LayerFields

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

export const useKeymap = (): Keymap => {
  const renderer = useRenderer()
  return getKeymap(renderer)
}

// Use the batched `state` event for derived reads. Pending-sequence changes
// already flow through `state`, so subscribing to both would duplicate work.
function useKeymapStateVersion(keymap: Keymap): Accessor<number> {
  const [version, setVersion] = createSignal(0)
  let dispose: (() => void) | undefined

  onMount(() => {
    dispose = keymap.on("state", () => {
      setVersion((value) => value + 1)
    })

    setVersion((value) => value + 1)
  })

  onCleanup(() => {
    dispose?.()
  })

  return version
}

export const useActiveKeys = (options?: ActiveKeyOptions): Accessor<readonly ActiveKey[]> => {
  const keymap = useKeymap()
  const version = useKeymapStateVersion(keymap)

  return createMemo(() => {
    version()
    return keymap.getActiveKeys(options)
  })
}

export const usePendingSequence = (): Accessor<readonly KeySequencePart[]> => {
  const keymap = useKeymap()
  const version = useKeymapStateVersion(keymap)

  return createMemo(() => {
    version()
    return keymap.getPendingSequence()
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
  const keymap = useKeymap()
  let dispose: (() => void) | undefined
  let mounted = false
  let registered = false
  let registeredScope: Layer["scope"] | undefined
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

    let resolvedLayer: Layer
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

    dispose = keymap.registerLayer(resolvedLayer)
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
 * Adapts a Solid accessor to `ReactiveMatcher`. The subscription
 * lives in a disposable reactive root so unregistering the layer tears it
 * down. Pass `predicate` when the accessor value is not already boolean.
 */
export function reactiveMatcherFromSignal<T>(
  accessor: Accessor<T>,
  predicate?: (value: T) => boolean,
): ReactiveMatcher {
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
