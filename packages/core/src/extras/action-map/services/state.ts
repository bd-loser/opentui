import type { Renderable } from "../../../Renderable.js"
import type {
  ActiveKey,
  BindingExpander,
  BindingFieldCompiler,
  BindingParser,
  BindingSyntax,
  BindingTransformer,
  CommandFieldCompiler,
  CommandResolver,
  EventData,
  EventMatchResolver,
  KeyInputContext,
  LayerFieldCompiler,
  RawInputContext,
  ParsedKeyPart,
  ParsedKeyStroke,
  ParsedKeyToken,
  PendingSequenceState,
  RegisteredCommand,
  RegisteredLayer,
  RegisteredLayerBucket,
  ResolvedBindingCommand,
  RuntimeMatchable,
} from "../types.js"
import { OrderedRegistry, PriorityRegistry } from "../lib/registry.js"

const EMPTY_DATA: Readonly<EventData> = Object.freeze({})

export interface CoreState {
  order: number
}

export interface ConfigState {
  tokens: Map<string, ParsedKeyToken>
  bindingSyntax: BindingSyntax | undefined
  layerFields: Map<string, LayerFieldCompiler>
  bindingExpanders: OrderedRegistry<BindingExpander>
  bindingParsers: OrderedRegistry<BindingParser>
  bindingTransformers: OrderedRegistry<BindingTransformer>
  bindingFields: Map<string, BindingFieldCompiler>
  commandFields: Map<string, CommandFieldCompiler>
  commandResolvers: OrderedRegistry<CommandResolver>
  eventMatchResolvers: OrderedRegistry<EventMatchResolver>
  keyHooks: PriorityRegistry<(ctx: KeyInputContext) => void, { priority: number; release: boolean }>
  rawHooks: PriorityRegistry<(ctx: RawInputContext) => void, { priority: number }>
}

export interface LayersState {
  layers: Set<RegisteredLayer>
  globalLayers: RegisteredLayer[]
  targetLayers: WeakMap<Renderable, RegisteredLayerBucket>
  layersWithConditions: number
  layersWithCommands: number
}

export interface LayerCommandEntry {
  layer: RegisteredLayer
  command: RegisteredCommand
}

export interface ResolvedCommandEntry {
  target?: Renderable
  resolved: ResolvedBindingCommand
}

export interface ActiveCommandView {
  entries: readonly LayerCommandEntry[]
  reachable: readonly LayerCommandEntry[]
  reachableByName: ReadonlyMap<string, LayerCommandEntry>
  chainsByName: ReadonlyMap<string, readonly LayerCommandEntry[]>
  resolvedWithoutRecordChains: Map<string, readonly ResolvedCommandEntry[]>
  resolvedWithRecordChains: Map<string, readonly ResolvedCommandEntry[]>
  fallbackWithoutRecord: Map<string, ResolvedBindingCommand | null>
  fallbackWithRecord: Map<string, ResolvedBindingCommand | null>
  fallbackWithoutRecordErrors: Set<string>
  fallbackWithRecordErrors: Set<string>
}

export interface CommandsState {
  commandMetadataVersion: number
  registeredNames: Map<string, number>
}

export interface ProjectionState {
  pendingSequence: PendingSequenceState | null
  pendingSequenceCacheVersion: number
  pendingSequenceCache: readonly ParsedKeyStroke[]
  pendingSequencePartsCacheVersion: number
  pendingSequencePartsCache: readonly ParsedKeyPart[]
  activeCommandViewVersion: number
  activeCommandView?: ActiveCommandView
  registeredCommandsCacheVersion: number
  registeredCommandsCache: readonly RegisteredCommand[]
  activeKeysPlainCacheVersion: number
  activeKeysPlainCache: readonly ActiveKey[]
  activeKeysBindingsCacheVersion: number
  activeKeysBindingsCache: readonly ActiveKey[]
  activeKeysMetadataCacheVersion: number
  activeKeysMetadataCache: readonly ActiveKey[]
  activeKeysBindingsAndMetadataCacheVersion: number
  activeKeysBindingsAndMetadataCache: readonly ActiveKey[]
}

export interface ConditionsState {
  runtimeKeyDependents: Map<string, Set<RuntimeMatchable>>
}

export interface RuntimeState {
  data: EventData
  dataVersion: number
  readonlyDataVersion: number
  readonlyData: Readonly<EventData>
}

export interface NotifyState {
  derivedStateVersion: number
  stateChangeDepth: number
  stateChangePending: boolean
  flushingStateChange: boolean
  usedWarningKeys: Set<string>
}

export interface State {
  core: CoreState
  config: ConfigState
  layers: LayersState
  commands: CommandsState
  projection: ProjectionState
  conditions: ConditionsState
  runtime: RuntimeState
  notify: NotifyState
}

export function createActionMapState(): State {
  return {
    core: {
      order: 0,
    },
    config: {
      tokens: new Map<string, ParsedKeyToken>(),
      bindingSyntax: undefined,
      layerFields: new Map<string, LayerFieldCompiler>(),
      bindingExpanders: new OrderedRegistry<BindingExpander>(),
      bindingParsers: new OrderedRegistry<BindingParser>(),
      bindingTransformers: new OrderedRegistry<BindingTransformer>(),
      bindingFields: new Map<string, BindingFieldCompiler>(),
      commandFields: new Map<string, CommandFieldCompiler>(),
      commandResolvers: new OrderedRegistry<CommandResolver>(),
      eventMatchResolvers: new OrderedRegistry<EventMatchResolver>(),
      keyHooks: new PriorityRegistry<(ctx: KeyInputContext) => void, { priority: number; release: boolean }>(),
      rawHooks: new PriorityRegistry<(ctx: RawInputContext) => void, { priority: number }>(),
    },
    layers: {
      layers: new Set<RegisteredLayer>(),
      globalLayers: [],
      targetLayers: new WeakMap<Renderable, RegisteredLayerBucket>(),
      layersWithConditions: 0,
      layersWithCommands: 0,
    },
    commands: {
      commandMetadataVersion: 0,
      registeredNames: new Map<string, number>(),
    },
    projection: {
      pendingSequence: null,
      pendingSequenceCacheVersion: -1,
      pendingSequenceCache: [],
      pendingSequencePartsCacheVersion: -1,
      pendingSequencePartsCache: [],
      activeCommandViewVersion: -1,
      activeCommandView: undefined,
      registeredCommandsCacheVersion: -1,
      registeredCommandsCache: [],
      activeKeysPlainCacheVersion: -1,
      activeKeysPlainCache: [],
      activeKeysBindingsCacheVersion: -1,
      activeKeysBindingsCache: [],
      activeKeysMetadataCacheVersion: -1,
      activeKeysMetadataCache: [],
      activeKeysBindingsAndMetadataCacheVersion: -1,
      activeKeysBindingsAndMetadataCache: [],
    },
    conditions: {
      runtimeKeyDependents: new Map<string, Set<RuntimeMatchable>>(),
    },
    runtime: {
      data: {},
      dataVersion: 0,
      readonlyDataVersion: -1,
      readonlyData: EMPTY_DATA,
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
