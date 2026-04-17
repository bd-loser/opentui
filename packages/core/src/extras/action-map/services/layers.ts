import { RenderableEvents, type Renderable } from "../../../Renderable.js"
import type { CompilerService } from "./compiler.js"
import type { ConditionService } from "./conditions.js"
import type { RuntimeService } from "./runtime.js"
import type {
  ActionMapBindingInput,
  ActionMapEventData,
  ActionMapLayer,
  ActionMapScope,
  ParsedKeyToken,
  PendingSequenceState,
  RegisteredLayer,
  RegisteredLayerBucket,
  RuntimeMatcher,
} from "../types.js"
import type { ActionMapState } from "./state.js"
import type { NotificationService } from "./notify.js"
import {
  getErrorMessage,
  mergeRequirement,
  snapshotBindingInputs,
  snapshotDataValue,
  sortByPriorityAndOrder,
} from "../lib/utils.js"

const NOOP = (): void => {}

export const RESERVED_LAYER_FIELDS = new Set(["target", "scope", "priority", "bindings"])

interface CompileLayerRuntimeStateResult {
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
  hasUnkeyedMatchers: boolean
  compileFields?: Readonly<Record<string, unknown>>
}

interface ActionMapLayersOptions {
  compiler: CompilerService
  warnUnknownField: (kind: "binding" | "layer", fieldName: string) => void
}

export class LayerService {
  constructor(
    private readonly state: ActionMapState,
    private readonly notify: NotificationService,
    private readonly conditions: ConditionService,
    private readonly runtime: RuntimeService,
    private readonly options: ActionMapLayersOptions,
  ) {}

  public registerLayer(layer: ActionMapLayer): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.notify.runWithStateChangeBatch(() => {
      const target = layer.target
      if (target && target.isDestroyed) {
        this.notify.emitError("Cannot register an action map layer for a destroyed renderable")
        return NOOP
      }

      let scope: ActionMapScope
      let bindingInputs: ActionMapBindingInput[]
      let requires: readonly [name: string, value: unknown][]
      let matchers: readonly RuntimeMatcher[]
      let conditionKeys: readonly string[]
      let hasUnkeyedMatchers: boolean
      let compileFields: Readonly<Record<string, unknown>> | undefined

      try {
        scope = this.normalizeScope(layer)
        bindingInputs = snapshotBindingInputs(layer.bindings)
        ;({ requires, matchers, conditionKeys, hasUnkeyedMatchers, compileFields } =
          this.compileLayerRuntimeState(layer))
      } catch (error) {
        this.notify.emitError(getErrorMessage(error, "Failed to register action map layer"), error)
        return NOOP
      }

      const order = this.state.core.order++
      const compiledBindings = this.options.compiler.compileBindings(
        bindingInputs,
        this.state.config.tokens,
        scope,
        target,
        order,
        compileFields,
      )

      if (compiledBindings.bindings.length === 0 && !compiledBindings.hasTokenBindings) {
        return NOOP
      }

      const registeredLayer: RegisteredLayer = {
        order,
        target,
        scope,
        priority: layer.priority ?? 0,
        requires,
        matchers,
        conditionKeys,
        hasUnkeyedMatchers,
        matchCacheDirty: true,
        compileFields,
        bindingInputs,
        compiledBindings: compiledBindings.bindings,
        hasUnkeyedBindings: compiledBindings.bindings.some((binding) => binding.hasUnkeyedMatchers),
        hasTokenBindings: compiledBindings.hasTokenBindings,
        root: compiledBindings.root,
      }

      this.state.layers.layers.add(registeredLayer)
      if (registeredLayer.requires.length > 0 || registeredLayer.matchers.length > 0) {
        this.state.layers.layersWithConditions += 1
      }
      this.conditions.registerRuntimeMatchable(registeredLayer)
      for (const binding of registeredLayer.compiledBindings) {
        this.conditions.registerRuntimeMatchable(binding)
      }
      this.indexLayer(registeredLayer)

      if (target) {
        const onTargetDestroy = () => {
          this.unregisterLayer(registeredLayer)
        }

        target.once(RenderableEvents.DESTROYED, onTargetDestroy)
        registeredLayer.offTargetDestroy = () => {
          target.off(RenderableEvents.DESTROYED, onTargetDestroy)
        }
      }

      this.notify.queueStateChange()

      return () => {
        this.unregisterLayer(registeredLayer)
      }
    })
  }

  public applyTokenState(nextTokens: Map<string, ParsedKeyToken>): void {
    this.notify.runWithStateChangeBatch(() => {
      const nextCompilations = new Map<RegisteredLayer, CompiledBindingsResult>()

      for (const layer of this.state.layers.layers) {
        if (!layer.hasTokenBindings) {
          continue
        }

        nextCompilations.set(
          layer,
          this.options.compiler.compileBindings(
            layer.bindingInputs,
            nextTokens,
            layer.scope,
            layer.target,
            layer.order,
            layer.compileFields,
          ),
        )
      }

      this.state.config.tokens = nextTokens

      let shouldClearPending = false
      for (const [layer, compilation] of nextCompilations) {
        for (const binding of layer.compiledBindings) {
          this.conditions.unregisterRuntimeMatchable(binding)
        }

        layer.root = compilation.root
        layer.compiledBindings = compilation.bindings

        for (const binding of layer.compiledBindings) {
          this.conditions.registerRuntimeMatchable(binding)
        }

        if (this.state.runtime.pendingSequence?.layer === layer) {
          shouldClearPending = true
        }
      }

      if (shouldClearPending) {
        this.runtime.setPendingSequence(null)
      }

      if (nextCompilations.size > 0) {
        this.notify.queueStateChange()
      }
    })
  }

  public getActiveLayers(focused: Renderable | null): RegisteredLayer[] {
    const activeLayers: RegisteredLayer[] = []

    if (focused) {
      let current: Renderable | null = focused
      let isFocusedTarget = true

      while (current) {
        const bucket = this.state.layers.targetLayers.get(current)
        if (bucket) {
          if (isFocusedTarget) {
            activeLayers.push(...bucket.focusLayers)
          }

          activeLayers.push(...bucket.focusWithinLayers)
        }

        current = current.parent
        isFocusedTarget = false
      }
    }

    activeLayers.push(...this.state.layers.globalLayers)

    return activeLayers
  }

  public isLayerActiveForFocused(layer: RegisteredLayer, focused: Renderable | null): boolean {
    if (layer.scope === "global") {
      return true
    }

    const target = layer.target
    if (!target || target.isDestroyed || !focused) {
      return false
    }

    if (layer.scope === "focus") {
      return target === focused
    }

    let current: Renderable | null = focused
    while (current) {
      if (current === target) {
        return true
      }

      current = current.parent
    }

    return false
  }

  public layerCanCacheActiveKeys(layer: RegisteredLayer): boolean {
    return !layer.hasUnkeyedMatchers && !layer.hasUnkeyedBindings
  }

  public activeLayersCanCacheActiveKeys(activeLayers: readonly RegisteredLayer[]): boolean {
    for (const layer of activeLayers) {
      if (!this.layerCanCacheActiveKeys(layer)) {
        return false
      }
    }

    return true
  }

  private normalizeScope(layer: ActionMapLayer): ActionMapScope {
    if (layer.scope) {
      if (layer.scope !== "global" && !layer.target) {
        throw new Error(`ActionMap scope "${layer.scope}" requires a target renderable`)
      }

      return layer.scope
    }

    if (layer.target) {
      return "focus-within"
    }

    return "global"
  }

  private compileLayerRuntimeState(layer: ActionMapLayer): CompileLayerRuntimeStateResult {
    const mergedRequires: ActionMapEventData = {}
    const matchers: RuntimeMatcher[] = []
    const compileFields: Record<string, unknown> = Object.create(null)
    const conditionKeys = new Set<string>()
    let hasUnkeyedMatchers = false

    for (const [fieldName, value] of Object.entries(layer)) {
      if (RESERVED_LAYER_FIELDS.has(fieldName)) {
        continue
      }

      if (value === undefined) {
        continue
      }

      compileFields[fieldName] = snapshotDataValue(value)

      const compiler = this.state.config.layerFields.get(fieldName)
      if (!compiler) {
        this.options.warnUnknownField("layer", fieldName)
        continue
      }

      compiler(value, {
        require: (name, requiredValue) => {
          mergeRequirement(mergedRequires, name, requiredValue, `field ${fieldName}`)
          conditionKeys.add(name)
        },
        match: (matcher) => {
          const runtimeMatcher = this.conditions.buildRuntimeMatcher(matcher, `field ${fieldName}`)
          if (!runtimeMatcher.cacheable) {
            hasUnkeyedMatchers = true
          }
          matchers.push(runtimeMatcher)
        },
      })
    }

    return {
      requires: Object.entries(mergedRequires),
      matchers,
      conditionKeys: [...conditionKeys],
      hasUnkeyedMatchers,
      compileFields: Object.keys(compileFields).length > 0 ? Object.freeze(compileFields) : undefined,
    }
  }

  private getOrCreateTargetBucket(target: Renderable): RegisteredLayerBucket {
    const existing = this.state.layers.targetLayers.get(target)
    if (existing) {
      return existing
    }

    const bucket: RegisteredLayerBucket = {
      focusLayers: [],
      focusWithinLayers: [],
    }
    this.state.layers.targetLayers.set(target, bucket)
    return bucket
  }

  private indexLayer(layer: RegisteredLayer): void {
    if (layer.scope === "global") {
      this.state.layers.globalLayers = sortByPriorityAndOrder([...this.state.layers.globalLayers, layer], {
        order: "desc",
      })
      return
    }

    const target = layer.target
    if (!target) {
      return
    }

    const bucket = this.getOrCreateTargetBucket(target)
    if (layer.scope === "focus") {
      bucket.focusLayers = sortByPriorityAndOrder([...bucket.focusLayers, layer], { order: "desc" })
    } else {
      bucket.focusWithinLayers = sortByPriorityAndOrder([...bucket.focusWithinLayers, layer], { order: "desc" })
    }

    layer.bucket = bucket
  }

  private removeLayerFromIndex(layer: RegisteredLayer): void {
    if (layer.scope === "global") {
      this.state.layers.globalLayers = this.state.layers.globalLayers.filter((candidate) => candidate !== layer)
      return
    }

    const target = layer.target
    const bucket = layer.bucket
    if (!target || !bucket) {
      return
    }

    if (layer.scope === "focus") {
      bucket.focusLayers = bucket.focusLayers.filter((candidate) => candidate !== layer)
    } else {
      bucket.focusWithinLayers = bucket.focusWithinLayers.filter((candidate) => candidate !== layer)
    }

    if (bucket.focusLayers.length === 0 && bucket.focusWithinLayers.length === 0) {
      this.state.layers.targetLayers.delete(target)
    }

    layer.bucket = undefined
  }

  private unregisterLayer(layer: RegisteredLayer): void {
    this.notify.runWithStateChangeBatch(() => {
      if (!this.state.layers.layers.delete(layer)) {
        return
      }

      if (layer.requires.length > 0 || layer.matchers.length > 0) {
        this.state.layers.layersWithConditions -= 1
      }

      this.conditions.unregisterRuntimeMatchable(layer)
      for (const binding of layer.compiledBindings) {
        this.conditions.unregisterRuntimeMatchable(binding)
      }

      this.removeLayerFromIndex(layer)
      layer.offTargetDestroy?.()
      layer.offTargetDestroy = undefined

      if (this.state.runtime.pendingSequence?.layer === layer) {
        this.runtime.setPendingSequence(null)
      }

      this.notify.queueStateChange()
    })
  }
}
