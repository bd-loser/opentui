import type { KeyEvent, Renderable } from "@opentui/core"
import {
  type ActiveKey,
  type ActiveKeyOptions,
  type Layer,
  type LayerFields,
  type Keymap,
  type ReactiveMatcher,
  type KeySequencePart,
} from "../index.js"
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type DependencyList } from "react"
import { useRenderer } from "@opentui/react"
import { getKeymap } from "../opentui.js"

export type UseBindingsTarget<TRenderable extends Renderable = Renderable> =
  | TRenderable
  | null
  | undefined
  | (() => TRenderable | null | undefined)

type UseBindingsLayerBase = LayerFields<Renderable, KeyEvent>

export type BindingsRef<TRenderable extends Renderable = Renderable> = (value: TRenderable | null) => void

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

export const useKeymap = (): Keymap<Renderable, KeyEvent> => {
  const renderer = useRenderer()
  return useMemo(() => getKeymap(renderer), [renderer])
}

// Use the batched `state` event for derived reads. Pending-sequence changes
// already flow through `state`, so subscribing to both would duplicate work.
function useKeymapStateVersion(keymap: Keymap<Renderable, KeyEvent>): number {
  const [version, bumpVersion] = useReducer((value: number) => value + 1, 0)

  useLayoutEffect(() => {
    const dispose = keymap.on("state", () => {
      bumpVersion()
    })

    return () => {
      dispose()
    }
  }, [keymap])

  return version
}

export const useActiveKeys = (options?: ActiveKeyOptions): readonly ActiveKey[] => {
  const keymap = useKeymap()
  const version = useKeymapStateVersion(keymap)

  return useMemo(() => {
    void version
    return keymap.getActiveKeys(options)
  }, [keymap, options, version])
}

export const usePendingSequence = (): readonly KeySequencePart[] => {
  const keymap = useKeymap()
  const version = useKeymapStateVersion(keymap)

  return useMemo(() => {
    void version
    return keymap.getPendingSequence()
  }, [keymap, version])
}

export function useBindings<TRenderable extends Renderable = Renderable>(
  createLayer: () => UseGlobalBindingsLayer,
  deps?: DependencyList,
): BindingsRef<TRenderable>
export function useBindings<TRenderable extends Renderable = Renderable>(
  createLayer: () => UseTargetBindingsLayer<TRenderable>,
  deps?: DependencyList,
): BindingsRef<TRenderable>
export function useBindings<TRenderable extends Renderable = Renderable>(
  createLayer: () => UseBindingsLayer<TRenderable>,
  deps: DependencyList = [],
): BindingsRef<TRenderable> {
  const keymap = useKeymap()
  const layer = useMemo(createLayer, deps)
  const layerRef = useRef(layer)
  const refTargetRef = useRef<TRenderable | undefined>(undefined)
  const disposeRef = useRef<(() => void) | undefined>(undefined)
  const mountedRef = useRef(false)
  const registeredScopeRef = useRef<Layer<Renderable, KeyEvent>["scope"] | undefined>(undefined)
  const registeredTargetRef = useRef<Renderable | undefined>(undefined)

  layerRef.current = layer

  const unregister = useCallback(() => {
    disposeRef.current?.()
    disposeRef.current = undefined
    registeredScopeRef.current = undefined
    registeredTargetRef.current = undefined
  }, [])

  const register = useCallback(() => {
    if (disposeRef.current) {
      return
    }

    const currentLayer = layerRef.current
    const explicitTarget = resolveBindingsTarget(currentLayer.target)
    const resolvedTarget = explicitTarget ?? refTargetRef.current
    const resolvedScope = currentLayer.scope ?? (resolvedTarget ? "focus-within" : "global")

    if (currentLayer.target !== undefined && !explicitTarget) {
      throw new Error("useBindings target was not available during mount")
    }

    if (resolvedScope !== "global" && !resolvedTarget) {
      throw new Error("useBindings local bindings need a target or the returned ref callback attached to a renderable")
    }

    const { scope: _scope, target: _target, ...baseLayer } = currentLayer

    const resolvedLayer: Layer<Renderable, KeyEvent> =
      resolvedScope === "global"
        ? {
            ...baseLayer,
            scope: "global",
          }
        : {
            ...baseLayer,
            scope: resolvedScope,
            target: resolvedTarget!,
          }

    disposeRef.current = keymap.registerLayer(resolvedLayer)
    registeredScopeRef.current = resolvedScope
    registeredTargetRef.current = resolvedScope === "global" ? undefined : resolvedTarget
  }, [keymap])

  const ref = useCallback<BindingsRef<TRenderable>>((value) => {
    refTargetRef.current = value ?? undefined
  }, [])

  useEffect(() => {
    mountedRef.current = true
    unregister()
    register()

    return () => {
      mountedRef.current = false
      unregister()
    }
  }, [layer, register, unregister])

  useEffect(() => {
    if (!mountedRef.current) {
      return
    }

    const currentLayer = layerRef.current
    if (currentLayer.target !== undefined || currentLayer.scope === "global") {
      return
    }

    const resolvedTarget = refTargetRef.current
    const resolvedScope = currentLayer.scope ?? (resolvedTarget ? "focus-within" : "global")
    const nextTarget = resolvedScope === "global" ? undefined : resolvedTarget

    if (registeredScopeRef.current === resolvedScope && registeredTargetRef.current === nextTarget) {
      return
    }

    unregister()

    if (!nextTarget && currentLayer.scope !== undefined) {
      return
    }

    register()
  })

  return ref
}

/**
 * Adapts any `subscribe` + `getSnapshot` store to
 * `ReactiveMatcher`. Pass `predicate` when the snapshot value is not
 * already boolean.
 */
export function reactiveMatcherFromStore<T>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  predicate?: (value: T) => boolean,
): ReactiveMatcher {
  return {
    get() {
      return predicate ? predicate(getSnapshot()) : Boolean(getSnapshot())
    },
    subscribe(onChange) {
      return subscribe(onChange)
    },
  }
}
