import type { Renderable } from "../../../Renderable.js"
import type {
  ActionMapActiveKey,
  ActionMapBindingCompiler,
  ActionMapBindingExpander,
  ActionMapBindingFieldCompiler,
  ActionMapBindingParser,
  ActionMapBindingSyntax,
  ActionMapCommandFieldCompiler,
  ActionMapCommandResolver,
  ActionMapEventData,
  ActionMapEventMatchResolver,
  ActionMapKeyInputContext,
  ActionMapLayerFieldCompiler,
  ActionMapRawInputContext,
  ParsedKeyPart,
  ParsedKeyStroke,
  ParsedKeyToken,
  PendingSequenceState,
  RegisteredCommand,
  RegisteredLayer,
  RegisteredLayerBucket,
  RuntimeMatchable,
} from "../types.js"
import { OrderedRegistry, PriorityRegistry } from "../lib/emitter.js"

const EMPTY_DATA: Readonly<ActionMapEventData> = Object.freeze({})

export interface ActionMapCoreState {
  order: number
  destroyed: boolean
}

export interface ActionMapConfigState {
  tokens: Map<string, ParsedKeyToken>
  bindingSyntax: ActionMapBindingSyntax | undefined
  layerFields: Map<string, ActionMapLayerFieldCompiler>
  bindingExpanders: OrderedRegistry<ActionMapBindingExpander>
  bindingParsers: OrderedRegistry<ActionMapBindingParser>
  bindingCompilers: OrderedRegistry<ActionMapBindingCompiler>
  bindingFields: Map<string, ActionMapBindingFieldCompiler>
  commandFields: Map<string, ActionMapCommandFieldCompiler>
  commandResolvers: OrderedRegistry<ActionMapCommandResolver>
  eventMatchResolvers: OrderedRegistry<ActionMapEventMatchResolver>
  keyHooks: PriorityRegistry<(ctx: ActionMapKeyInputContext) => void, { priority: number; release: boolean }>
  rawHooks: PriorityRegistry<(ctx: ActionMapRawInputContext) => void, { priority: number }>
}

export interface ActionMapLayersState {
  layers: Set<RegisteredLayer>
  globalLayers: RegisteredLayer[]
  targetLayers: WeakMap<Renderable, RegisteredLayerBucket>
  layersWithConditions: number
}

export interface ActionMapCommandsState {
  commands: Map<string, RegisteredCommand>
  commandMetadataVersion: number
}

export interface ActionMapConditionsState {
  runtimeKeyDependents: Map<string, Set<RuntimeMatchable>>
}

export interface ActionMapRuntimeState {
  data: ActionMapEventData
  dataVersion: number
  readonlyDataVersion: number
  readonlyData: Readonly<ActionMapEventData>
  pendingSequence: PendingSequenceState | null
  pendingSequenceCacheVersion: number
  pendingSequenceCache: readonly ParsedKeyStroke[]
  pendingSequencePartsCacheVersion: number
  pendingSequencePartsCache: readonly ParsedKeyPart[]
  activeKeysPlainCacheVersion: number
  activeKeysPlainCache: readonly ActionMapActiveKey[]
  activeKeysBindingsCacheVersion: number
  activeKeysBindingsCache: readonly ActionMapActiveKey[]
  activeKeysMetadataCacheVersion: number
  activeKeysMetadataCache: readonly ActionMapActiveKey[]
  activeKeysBindingsAndMetadataCacheVersion: number
  activeKeysBindingsAndMetadataCache: readonly ActionMapActiveKey[]
}

export interface ActionMapNotifyState {
  derivedStateVersion: number
  stateChangeDepth: number
  stateChangePending: boolean
  flushingStateChange: boolean
  usedWarningKeys: Set<string>
}

export interface ActionMapState {
  core: ActionMapCoreState
  config: ActionMapConfigState
  layers: ActionMapLayersState
  commands: ActionMapCommandsState
  conditions: ActionMapConditionsState
  runtime: ActionMapRuntimeState
  notify: ActionMapNotifyState
}

export interface ResetActionMapStateOptions {
  destroyed?: boolean
}

export function createActionMapState(): ActionMapState {
  return {
    core: {
      order: 0,
      destroyed: false,
    },
    config: {
      tokens: new Map<string, ParsedKeyToken>(),
      bindingSyntax: undefined,
      layerFields: new Map<string, ActionMapLayerFieldCompiler>(),
      bindingExpanders: new OrderedRegistry<ActionMapBindingExpander>(),
      bindingParsers: new OrderedRegistry<ActionMapBindingParser>(),
      bindingCompilers: new OrderedRegistry<ActionMapBindingCompiler>(),
      bindingFields: new Map<string, ActionMapBindingFieldCompiler>(),
      commandFields: new Map<string, ActionMapCommandFieldCompiler>(),
      commandResolvers: new OrderedRegistry<ActionMapCommandResolver>(),
      eventMatchResolvers: new OrderedRegistry<ActionMapEventMatchResolver>(),
      keyHooks: new PriorityRegistry<(ctx: ActionMapKeyInputContext) => void, { priority: number; release: boolean }>(),
      rawHooks: new PriorityRegistry<(ctx: ActionMapRawInputContext) => void, { priority: number }>(),
    },
    layers: {
      layers: new Set<RegisteredLayer>(),
      globalLayers: [],
      targetLayers: new WeakMap<Renderable, RegisteredLayerBucket>(),
      layersWithConditions: 0,
    },
    commands: {
      commands: new Map<string, RegisteredCommand>(),
      commandMetadataVersion: 0,
    },
    conditions: {
      runtimeKeyDependents: new Map<string, Set<RuntimeMatchable>>(),
    },
    runtime: {
      data: {},
      dataVersion: 0,
      readonlyDataVersion: -1,
      readonlyData: EMPTY_DATA,
      pendingSequence: null,
      pendingSequenceCacheVersion: -1,
      pendingSequenceCache: [],
      pendingSequencePartsCacheVersion: -1,
      pendingSequencePartsCache: [],
      activeKeysPlainCacheVersion: -1,
      activeKeysPlainCache: [],
      activeKeysBindingsCacheVersion: -1,
      activeKeysBindingsCache: [],
      activeKeysMetadataCacheVersion: -1,
      activeKeysMetadataCache: [],
      activeKeysBindingsAndMetadataCacheVersion: -1,
      activeKeysBindingsAndMetadataCache: [],
    },
    notify: {
      derivedStateVersion: 0,
      stateChangeDepth: 0,
      stateChangePending: false,
      flushingStateChange: false,
      usedWarningKeys: new Set<string>(),
    },
  }
}

export function resetActionMapState(state: ActionMapState, options?: ResetActionMapStateOptions): void {
  state.core.order = 0
  state.core.destroyed = options?.destroyed === true

  state.config.tokens.clear()
  state.config.bindingSyntax = undefined
  state.config.layerFields.clear()
  state.config.bindingExpanders.clear()
  state.config.bindingParsers.clear()
  state.config.bindingCompilers.clear()
  state.config.bindingFields.clear()
  state.config.commandFields.clear()
  state.config.commandResolvers.clear()
  state.config.eventMatchResolvers.clear()
  state.config.keyHooks.clear()
  state.config.rawHooks.clear()

  state.layers.layers.clear()
  state.layers.globalLayers = []
  state.layers.targetLayers = new WeakMap<Renderable, RegisteredLayerBucket>()
  state.layers.layersWithConditions = 0

  state.commands.commands.clear()
  state.commands.commandMetadataVersion = 0

  state.conditions.runtimeKeyDependents.clear()

  state.runtime.data = {}
  state.runtime.dataVersion = 0
  state.runtime.readonlyDataVersion = -1
  state.runtime.readonlyData = EMPTY_DATA
  state.runtime.pendingSequence = null
  state.runtime.pendingSequenceCacheVersion = -1
  state.runtime.pendingSequenceCache = []
  state.runtime.pendingSequencePartsCacheVersion = -1
  state.runtime.pendingSequencePartsCache = []
  state.runtime.activeKeysPlainCacheVersion = -1
  state.runtime.activeKeysPlainCache = []
  state.runtime.activeKeysBindingsCacheVersion = -1
  state.runtime.activeKeysBindingsCache = []
  state.runtime.activeKeysMetadataCacheVersion = -1
  state.runtime.activeKeysMetadataCache = []
  state.runtime.activeKeysBindingsAndMetadataCacheVersion = -1
  state.runtime.activeKeysBindingsAndMetadataCache = []

  state.notify.derivedStateVersion = 0
  state.notify.stateChangeDepth = 0
  state.notify.stateChangePending = false
  state.notify.flushingStateChange = false
  state.notify.usedWarningKeys.clear()
}
