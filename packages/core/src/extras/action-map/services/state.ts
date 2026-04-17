import type { Renderable } from "../../../Renderable.js"
import type {
  ActionMapActiveKey,
  ActionMapBindingExpander,
  ActionMapBindingFieldCompiler,
  ActionMapBindingParser,
  ActionMapBindingSyntax,
  ActionMapBindingTransformer,
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
import { OrderedRegistry, PriorityRegistry } from "../lib/registry.js"

const EMPTY_DATA: Readonly<ActionMapEventData> = Object.freeze({})

export interface ActionMapCoreState {
  order: number
}

export interface ActionMapConfigState {
  tokens: Map<string, ParsedKeyToken>
  bindingSyntax: ActionMapBindingSyntax | undefined
  layerFields: Map<string, ActionMapLayerFieldCompiler>
  bindingExpanders: OrderedRegistry<ActionMapBindingExpander>
  bindingParsers: OrderedRegistry<ActionMapBindingParser>
  bindingTransformers: OrderedRegistry<ActionMapBindingTransformer>
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

export function createActionMapState(): ActionMapState {
  return {
    core: {
      order: 0,
    },
    config: {
      tokens: new Map<string, ParsedKeyToken>(),
      bindingSyntax: undefined,
      layerFields: new Map<string, ActionMapLayerFieldCompiler>(),
      bindingExpanders: new OrderedRegistry<ActionMapBindingExpander>(),
      bindingParsers: new OrderedRegistry<ActionMapBindingParser>(),
      bindingTransformers: new OrderedRegistry<ActionMapBindingTransformer>(),
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
