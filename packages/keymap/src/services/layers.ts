import type { CompilerService } from "./compiler.js"
import type { CommandService } from "./commands.js"
import type { ConditionService } from "./conditions.js"
import type { ProjectionService } from "./projection.js"
import type {
  BindingInput,
  CompiledBinding,
  CompiledBindingsResult,
  EventData,
  KeymapEvent,
  KeymapHost,
  Layer,
  LayerAnalysisContext,
  Scope,
  ResolvedKeyToken,
  RegisteredCommand,
  RegisteredLayer,
  RegisteredLayerBucket,
  RuntimeMatcher,
} from "../types.js"
import { RESERVED_LAYER_FIELDS } from "../schema.js"
import type { State } from "./state.js"
import type { NotificationService } from "./notify.js"
import {
  getErrorMessage,
  mergeRequirement,
  snapshotBindingInputs,
  snapshotDataValue,
  sortByPriorityAndOrder,
} from "../lib/utils.js"

const NOOP = (): void => {}

function createCommandLookup<TTarget extends object, TEvent extends KeymapEvent>(
  commands: readonly RegisteredCommand<TTarget, TEvent>[],
): ReadonlyMap<string, RegisteredCommand<TTarget, TEvent>> | undefined {
  if (commands.length === 0) {
    return undefined
  }

  const lookup = new Map<string, RegisteredCommand<TTarget, TEvent>>()
  for (const command of commands) {
    lookup.set(command.name, command)
  }

  return lookup
}

function addRegisteredCommandNames<TTarget extends object, TEvent extends KeymapEvent>(
  target: Map<string, number>,
  commands: readonly RegisteredCommand<TTarget, TEvent>[],
): void {
  for (const command of commands) {
    target.set(command.name, (target.get(command.name) ?? 0) + 1)
  }
}

function removeRegisteredCommandNames<TTarget extends object, TEvent extends KeymapEvent>(
  target: Map<string, number>,
  commands: readonly RegisteredCommand<TTarget, TEvent>[],
): void {
  for (const command of commands) {
    const count = target.get(command.name)
    if (!count || count <= 1) {
      target.delete(command.name)
      continue
    }

    target.set(command.name, count - 1)
  }
}

interface CompileLayerRuntimeStateResult {
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
  hasUnkeyedMatchers: boolean
  compileFields?: Readonly<Record<string, unknown>>
}

interface LayersOptions<TTarget extends object, TEvent extends KeymapEvent> {
  compiler: CompilerService<TTarget, TEvent>
  commands: CommandService<TTarget, TEvent>
  host: KeymapHost<TTarget, TEvent>
  warnUnknownField: (kind: "binding" | "layer", fieldName: string) => void
}

interface AnalyzeLayerOptions<TTarget extends object, TEvent extends KeymapEvent> {
  scope: Scope
  target?: TTarget
  order: number
  bindingInputs: readonly BindingInput<TTarget, TEvent>[]
  compiledBindings: readonly CompiledBinding<TTarget, TEvent>[]
  root: RegisteredLayer<TTarget, TEvent>["root"]
  hasTokenBindings: boolean
}

export class LayerService<TTarget extends object, TEvent extends KeymapEvent> {
  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly notify: NotificationService<TTarget, TEvent>,
    private readonly conditions: ConditionService<TTarget, TEvent>,
    private readonly projection: ProjectionService<TTarget, TEvent>,
    private readonly options: LayersOptions<TTarget, TEvent>,
  ) {}

  public registerLayer(layer: Layer<TTarget, TEvent>): () => void {
    return this.notify.runWithStateChangeBatch(() => {
      const target = layer.target
      if (target && this.options.host.isTargetDestroyed(target)) {
        this.notify.emitError(
          "destroyed-layer-target",
          { target },
          "Cannot register a keymap layer for a destroyed keymap target",
        )
        return NOOP
      }

      let scope: Scope
      let bindingInputs: BindingInput<TTarget, TEvent>[]
      let requires: readonly [name: string, value: unknown][]
      let matchers: readonly RuntimeMatcher[]
      let conditionKeys: readonly string[]
      let hasUnkeyedMatchers: boolean
      let compileFields: Readonly<Record<string, unknown>> | undefined
      let commands: readonly RegisteredCommand<TTarget, TEvent>[]
      let commandLookup: ReadonlyMap<string, RegisteredCommand<TTarget, TEvent>> | undefined
      let indexTarget: TTarget

      try {
        scope = this.normalizeScope(layer)
        indexTarget = layer.target ?? this.options.host.rootTarget
        bindingInputs = snapshotBindingInputs(layer.bindings ?? [])
        commands =
          !layer.commands || layer.commands.length === 0 ? [] : this.options.commands.normalizeCommands(layer.commands)
        commandLookup = createCommandLookup(commands)
        ;({ requires, matchers, conditionKeys, hasUnkeyedMatchers, compileFields } =
          this.compileLayerRuntimeState(layer))
      } catch (error) {
        this.notify.emitError("register-layer-failed", error, getErrorMessage(error, "Failed to register keymap layer"))
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
        commandLookup,
      )

      if (compiledBindings.bindings.length === 0 && !compiledBindings.hasTokenBindings && commands.length === 0) {
        return NOOP
      }

      this.runLayerAnalyzers({
        scope,
        target,
        order,
        bindingInputs,
        compiledBindings: compiledBindings.bindings,
        root: compiledBindings.root,
        hasTokenBindings: compiledBindings.hasTokenBindings,
      })

      const registeredLayer: RegisteredLayer<TTarget, TEvent> = {
        order,
        target,
        indexTarget,
        scope,
        priority: layer.priority ?? 0,
        requires,
        matchers,
        conditionKeys,
        hasUnkeyedMatchers,
        matchCacheDirty: true,
        compileFields,
        commands,
        commandLookup,
        bindingInputs,
        compiledBindings: compiledBindings.bindings,
        hasUnkeyedBindings: compiledBindings.bindings.some((binding) => binding.hasUnkeyedMatchers),
        hasTokenBindings: compiledBindings.hasTokenBindings,
        root: compiledBindings.root,
      }

      this.state.layers.layers.add(registeredLayer)
      if (registeredLayer.commands.length > 0) {
        this.state.layers.layersWithCommands += 1
        this.state.commands.commandMetadataVersion += 1
        addRegisteredCommandNames(this.state.commands.registeredNames, registeredLayer.commands)
      }

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

          registeredLayer.offTargetDestroy = this.options.host.onTargetDestroy(target, onTargetDestroy)
        }

      if (registeredLayer.commands.length > 0) {
        this.projection.ensureValidPendingSequence()
      }

      this.notify.queueStateChange()

      return () => {
        this.unregisterLayer(registeredLayer)
      }
    })
  }

  public applyTokenState(nextTokens: Map<string, ResolvedKeyToken>): void {
    this.notify.runWithStateChangeBatch(() => {
      const nextCompilations = new Map<RegisteredLayer<TTarget, TEvent>, CompiledBindingsResult<TTarget, TEvent>>()

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
            layer.commandLookup,
          ),
        )
      }

      this.state.config.tokens = nextTokens

      let shouldClearPending = false
      for (const [layer, compilation] of nextCompilations) {
        this.runLayerAnalyzers({
          scope: layer.scope,
          target: layer.target,
          order: layer.order,
          bindingInputs: layer.bindingInputs,
          compiledBindings: compilation.bindings,
          root: compilation.root,
          hasTokenBindings: compilation.hasTokenBindings,
        })

        for (const binding of layer.compiledBindings) {
          this.conditions.unregisterRuntimeMatchable(binding)
        }

        layer.root = compilation.root
        layer.compiledBindings = compilation.bindings

        for (const binding of layer.compiledBindings) {
          this.conditions.registerRuntimeMatchable(binding)
        }

        if (this.state.projection.pendingSequence?.layer === layer) {
          shouldClearPending = true
        }
      }

      if (shouldClearPending) {
        this.projection.setPendingSequence(null)
      }

      if (nextCompilations.size > 0) {
        this.notify.queueStateChange()
      }
    })
  }

  private normalizeScope(layer: Layer<TTarget, TEvent>): Scope {
    if (layer.scope) {
      if (layer.scope !== "global" && !layer.target) {
        throw new Error(`Keymap scope "${layer.scope}" requires a target`)
      }

      return layer.scope
    }

    if (layer.target) {
      return "focus-within"
    }

    return "global"
  }
  private runLayerAnalyzers(options: AnalyzeLayerOptions<TTarget, TEvent>): void {
    const analyzers = this.state.config.layerAnalyzers.values()
    if (analyzers.length === 0) {
      return
    }

    const ctx: LayerAnalysisContext<TTarget, TEvent> = {
      scope: options.scope,
      target: options.target,
      order: options.order,
      bindingInputs: options.bindingInputs,
      compiledBindings: options.compiledBindings,
      root: options.root,
      hasTokenBindings: options.hasTokenBindings,
      warn: (code, warning, message) => {
        this.notify.emitWarning(code, warning, message)
      },
      warnOnce: (key, code, warning, message) => {
        this.notify.warnOnce(key, code, warning, message)
      },
      error: (code, error, message) => {
        this.notify.emitError(code, error, message)
      },
    }

    for (const analyzer of analyzers) {
      try {
        analyzer(ctx)
      } catch (error) {
        this.notify.emitError("layer-analyzer-error", error, "[Keymap] Error in layer analyzer:")
      }
    }
  }

  private compileLayerRuntimeState(layer: Layer<TTarget, TEvent>): CompileLayerRuntimeStateResult {
    const mergedRequires: EventData = {}
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

  private getOrCreateTargetBucket(target: TTarget): RegisteredLayerBucket<TTarget, TEvent> {
    const existing = this.state.layers.targetLayers.get(target)
    if (existing) {
      return existing
    }

    const bucket: RegisteredLayerBucket<TTarget, TEvent> = {
      focusLayers: [],
      focusWithinLayers: [],
    }
    this.state.layers.targetLayers.set(target, bucket)
    return bucket
  }

  private indexLayer(layer: RegisteredLayer<TTarget, TEvent>): void {
    const bucket = this.getOrCreateTargetBucket(layer.indexTarget)
    if (layer.scope === "focus") {
      bucket.focusLayers = sortByPriorityAndOrder([...bucket.focusLayers, layer], { order: "desc" })
    } else {
      bucket.focusWithinLayers = sortByPriorityAndOrder([...bucket.focusWithinLayers, layer], { order: "desc" })
    }

    layer.bucket = bucket
  }

  private removeLayerFromIndex(layer: RegisteredLayer<TTarget, TEvent>): void {
    const bucket = layer.bucket
    if (!bucket) {
      return
    }

    if (layer.scope === "focus") {
      bucket.focusLayers = bucket.focusLayers.filter((candidate) => candidate !== layer)
    } else {
      bucket.focusWithinLayers = bucket.focusWithinLayers.filter((candidate) => candidate !== layer)
    }

    if (bucket.focusLayers.length === 0 && bucket.focusWithinLayers.length === 0) {
      this.state.layers.targetLayers.delete(layer.indexTarget)
    }

    layer.bucket = undefined
  }

  private unregisterLayer(layer: RegisteredLayer<TTarget, TEvent>): void {
    this.notify.runWithStateChangeBatch(() => {
      if (!this.state.layers.layers.delete(layer)) {
        return
      }

      if (layer.requires.length > 0 || layer.matchers.length > 0) {
        this.state.layers.layersWithConditions -= 1
      }

      if (layer.commands.length > 0) {
        this.state.layers.layersWithCommands -= 1
        this.state.commands.commandMetadataVersion += 1
        removeRegisteredCommandNames(this.state.commands.registeredNames, layer.commands)
      }

      this.conditions.unregisterRuntimeMatchable(layer)
      for (const binding of layer.compiledBindings) {
        this.conditions.unregisterRuntimeMatchable(binding)
      }

      this.removeLayerFromIndex(layer)
      layer.offTargetDestroy?.()
      layer.offTargetDestroy = undefined

      if (this.state.projection.pendingSequence?.layer === layer) {
        this.projection.setPendingSequence(null)
      } else if (layer.commands.length > 0) {
        this.projection.ensureValidPendingSequence()
      }

      this.notify.queueStateChange()
    })
  }
}
