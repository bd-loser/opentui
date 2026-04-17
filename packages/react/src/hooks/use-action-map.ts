import type { Renderable } from "@opentui/core"
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react"
import { useRenderer } from "./use-renderer.js"

export type UseBindingsTarget<TRenderable extends Renderable = Renderable> =
  | TRenderable
  | null
  | undefined
  | (() => TRenderable | null | undefined)

type UseBindingsLayerBase = ActionMapLayerFields

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

export const useActionMap = (): ActionMap => {
  const renderer = useRenderer()
  return useMemo(() => getActionMap(renderer), [renderer])
}

// Use the batched `state` hook for derived reads. Pending-sequence changes
// already flow through `state`, so subscribing to both would duplicate work.
function useActionMapStateVersion(actionMap: ActionMap): number {
  const [version, bumpVersion] = useReducer((value: number) => value + 1, 0)

  useLayoutEffect(() => {
    const dispose = actionMap.hook("state", () => {
      bumpVersion()
    })

    return () => {
      dispose()
    }
  }, [actionMap])

  return version
}

export const useActiveKeys = (options?: ActionMapActiveKeyOptions): readonly ActionMapActiveKey[] => {
  const actionMap = useActionMap()
  const version = useActionMapStateVersion(actionMap)

  return useMemo(() => {
    void version
    return actionMap.getActiveKeys(options)
  }, [actionMap, options, version])
}

export const usePendingSequenceParts = (): readonly ParsedKeyPart[] => {
  const actionMap = useActionMap()
  const version = useActionMapStateVersion(actionMap)

  return useMemo(() => {
    void version
    return actionMap.getPendingSequenceParts()
  }, [actionMap, version])
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
  const actionMap = useActionMap()
  const layerRef = useRef(layer)
  const refTargetRef = useRef<TRenderable | undefined>(undefined)
  const disposeRef = useRef<(() => void) | undefined>(undefined)
  const mountedRef = useRef(false)
  const registeredScopeRef = useRef<ActionMapLayer["scope"] | undefined>(undefined)
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

    const resolvedLayer: ActionMapLayer =
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

    disposeRef.current = actionMap.registerLayer(resolvedLayer)
    registeredScopeRef.current = resolvedScope
    registeredTargetRef.current = resolvedScope === "global" ? undefined : resolvedTarget
  }, [actionMap])

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
 * `ActionMapReactiveMatcher`. Pass `predicate` when the snapshot value is not
 * already boolean.
 */
export function reactiveMatcherFromStore<T>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => T,
  predicate?: (value: T) => boolean,
): ActionMapReactiveMatcher {
  return {
    get() {
      return predicate ? predicate(getSnapshot()) : Boolean(getSnapshot())
    },
    subscribe(onChange) {
      return subscribe(onChange)
    },
  }
}
