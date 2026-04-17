import type { Renderable } from "../../Renderable.js"
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
} from "./types.js"
import { OrderedEmitter, RegistrationList } from "./emitter.js"

const EMPTY_DATA: Readonly<ActionMapEventData> = Object.freeze({})

export interface ActionMapCoreState {
  order: number
  destroyed: boolean
}

export interface ActionMapConfigState {
  tokens: Map<string, ParsedKeyToken>
  bindingSyntax: ActionMapBindingSyntax | undefined
  layerFields: Map<string, ActionMapLayerFieldCompiler>
  bindingExpanders: RegistrationList<ActionMapBindingExpander>
  bindingParsers: RegistrationList<ActionMapBindingParser>
  bindingCompilers: RegistrationList<ActionMapBindingCompiler>
  bindingFields: Map<string, ActionMapBindingFieldCompiler>
  commandFields: Map<string, ActionMapCommandFieldCompiler>
  commandResolvers: RegistrationList<ActionMapCommandResolver>
  eventMatchResolvers: RegistrationList<ActionMapEventMatchResolver>
  keyHooks: OrderedEmitter<(ctx: ActionMapKeyInputContext) => void, { priority: number; release: boolean }>
  rawHooks: OrderedEmitter<(ctx: ActionMapRawInputContext) => void, { priority: number }>
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
}

export interface ActionMapProjectionsState {
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
  projections: ActionMapProjectionsState
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
      bindingExpanders: new RegistrationList<ActionMapBindingExpander>(),
      bindingParsers: new RegistrationList<ActionMapBindingParser>(),
      bindingCompilers: new RegistrationList<ActionMapBindingCompiler>(),
      bindingFields: new Map<string, ActionMapBindingFieldCompiler>(),
      commandFields: new Map<string, ActionMapCommandFieldCompiler>(),
      commandResolvers: new RegistrationList<ActionMapCommandResolver>(),
      eventMatchResolvers: new RegistrationList<ActionMapEventMatchResolver>(),
      keyHooks: new OrderedEmitter<(ctx: ActionMapKeyInputContext) => void, { priority: number; release: boolean }>(),
      rawHooks: new OrderedEmitter<(ctx: ActionMapRawInputContext) => void, { priority: number }>(),
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
    },
    projections: {
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

  state.projections.pendingSequenceCacheVersion = -1
  state.projections.pendingSequenceCache = []
  state.projections.pendingSequencePartsCacheVersion = -1
  state.projections.pendingSequencePartsCache = []
  state.projections.activeKeysPlainCacheVersion = -1
  state.projections.activeKeysPlainCache = []
  state.projections.activeKeysBindingsCacheVersion = -1
  state.projections.activeKeysBindingsCache = []
  state.projections.activeKeysMetadataCacheVersion = -1
  state.projections.activeKeysMetadataCache = []
  state.projections.activeKeysBindingsAndMetadataCacheVersion = -1
  state.projections.activeKeysBindingsAndMetadataCache = []

  state.notify.derivedStateVersion = 0
  state.notify.stateChangeDepth = 0
  state.notify.stateChangePending = false
  state.notify.flushingStateChange = false
  state.notify.usedWarningKeys.clear()
}
