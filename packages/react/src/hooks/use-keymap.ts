import type { Renderable } from "@opentui/core"
import {
  getKeymapManager,
  type KeymapActiveKey,
  type KeymapActiveKeyOptions,
  type KeymapLayer,
  type KeymapLayerFields,
  type KeymapManager,
  type ParsedKeyPart,
} from "@opentui/core/extras"
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react"
import { useRenderer } from "./use-renderer.js"

export type UseKeymapTarget<TRenderable extends Renderable = Renderable> =
  | TRenderable
  | null
  | undefined
  | (() => TRenderable | null | undefined)

type UseKeymapLayerBase = KeymapLayerFields

export type KeymapRef<TRenderable extends Renderable = Renderable> = (value: TRenderable | null) => void

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

export const useKeymappings = (): KeymapManager => {
  const renderer = useRenderer()
  return useMemo(() => getKeymapManager(renderer), [renderer])
}

function useKeymapStateVersion(manager: KeymapManager): number {
  const [version, bumpVersion] = useReducer((value: number) => value + 1, 0)

  useLayoutEffect(() => {
    const dispose = manager.hook("state", () => {
      bumpVersion()
    })

    return () => {
      dispose()
    }
  }, [manager])

  return version
}

export const useActiveKeys = (options?: KeymapActiveKeyOptions): readonly KeymapActiveKey[] => {
  const manager = useKeymappings()
  const version = useKeymapStateVersion(manager)

  return useMemo(() => {
    void version
    return manager.getActiveKeys(options)
  }, [manager, options, version])
}

export const usePendingSequenceParts = (): readonly ParsedKeyPart[] => {
  const manager = useKeymappings()
  const version = useKeymapStateVersion(manager)

  return useMemo(() => {
    void version
    return manager.getPendingSequenceParts()
  }, [manager, version])
}

export function useKeymap<TRenderable extends Renderable = Renderable>(layer: UseGlobalKeymapLayer): KeymapRef<TRenderable>
export function useKeymap<TRenderable extends Renderable = Renderable>(layer: UseTargetKeymapLayer<TRenderable>): KeymapRef<TRenderable>
export function useKeymap<TRenderable extends Renderable = Renderable>(layer: UseKeymapLayer<TRenderable>): KeymapRef<TRenderable> {
  const manager = useKeymappings()
  const layerRef = useRef(layer)
  const refTargetRef = useRef<TRenderable | undefined>(undefined)

  layerRef.current = layer

  const ref = useCallback<KeymapRef<TRenderable>>((value) => {
    refTargetRef.current = value ?? undefined
  }, [])

  useEffect(() => {
    const currentLayer = layerRef.current
    const explicitTarget = resolveKeymapTarget(currentLayer.target)
    const resolvedTarget = explicitTarget ?? refTargetRef.current
    const resolvedScope = currentLayer.scope ?? (resolvedTarget ? "focus-within" : "global")

    if (currentLayer.target !== undefined && !explicitTarget) {
      throw new Error("useKeymap target was not available during mount")
    }

    if (resolvedScope !== "global" && !resolvedTarget) {
      throw new Error("useKeymap local bindings need a target or the returned ref callback attached to a renderable")
    }

    const { scope: _scope, target: _target, ...baseLayer } = currentLayer

    const resolvedLayer: KeymapLayer =
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

    return manager.registerLayer(resolvedLayer)
  }, [layer, manager])

  return ref
}
