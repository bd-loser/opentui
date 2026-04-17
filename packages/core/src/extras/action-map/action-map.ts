import { RenderableEvents, type Renderable } from "../../Renderable.js"
import { CliRenderEvents, type CliRenderer } from "../../renderer.js"
import { KeyEvent } from "../../lib/KeyHandler.js"
import type {
  ActiveKeySelection,
  ActiveKeyState,
  CompiledBinding,
  CompiledBindingsResult,
  ActionMapActiveBinding,
  ActionMapActiveKey,
  ActionMapActiveKeyOptions,
  ActionMapAttributes,
  ActionMapBindingCompiler,
  ActionMapBindingExpander,
  ActionMapBindingExpanderContext,
  ActionMapBindingParser,
  ActionMapBindingSyntax,
  ActionMapBindingCommand,
  ActionMapBindingEvent,
  ActionMapBindingFieldCompiler,
  ActionMapBindingInput,
  ActionMapBindingParserContext,
  ActionMapErrorEvent,
  ActionMapHookListener,
  ActionMapHookName,
  ActionMapHooks,
  ActionMapEvents,
  ActionMapParsedBindingInput,
  ActionMapCommandDefinition,
  ActionMapCommandContext,
  ActionMapCommandFieldCompiler,
  ActionMapCommandHandler,
  ActionMapCommandQuery,
  ActionMapCommandRecord,
  ActionMapRunCommandOptions,
  ActionMapRunCommandResult,
  ActionMapCommandResolver,
  ActionMapCommandResolverContext,
  ActionMapCommandResult,
  ActionMapEventData,
  ActionMapKeyInputContext,
  KeyLike,
  ActionMapLayer,
  ActionMapLayerFieldCompiler,
  ActionMapRawInputContext,
  ActionMapReactiveMatcher,
  ActionMapResolvedBindingCommand,
  ActionMapScope,
  ActionMapEventMatchResolver,
  KeyStroke,
  ActionMapToken,
  ActionMapUnresolvedCommandContext,
  ParsedKeyPart,
  ParsedKeyToken,
  ParsedKeyStroke,
  PendingSequenceState,
  RegisteredCommand,
  RegisteredLayer,
  RegisteredLayerBucket,
  RuntimeMatchable,
  RuntimeMatcher,
  SequenceNode,
  ActionMapWarningEvent,
} from "./types.js"
import {
  cloneStroke,
  createParsedKeyPart,
  createSequenceNode,
  freezeAttributes,
  isPromiseLike,
  mergeAttribute,
  mergeRequirement,
  normalizeBindingCommand,
  normalizeCommandName,
  snapshotBindingInputs,
  sortByPriorityAndOrder,
  stringifyKeySequence,
  stringifyKeyStroke,
} from "./utils.js"
import { queryRegisteredCommands } from "./command-query.js"
import { defaultBindingParser, defaultBindingSyntax, defaultEventMatchResolver } from "./default-parser.js"
import { Emitter, OrderedEmitter, RegistrationList, type EmitterListener } from "./emitter.js"

const actionMapsByRenderer = new WeakMap<CliRenderer, ActionMap>()
const NOOP = (): void => {}

export const RESERVED_BINDING_FIELDS = new Set(["key", "cmd", "event", "preventDefault", "fallthrough"])

const RESERVED_LAYER_FIELDS = new Set(["target", "scope", "priority", "bindings"])

const RESERVED_COMMAND_FIELDS = new Set(["name", "run"])
const EMPTY_COMPILE_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})
const EMPTY_COMMAND_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

function isReactiveMatcher(value: unknown): value is ActionMapReactiveMatcher {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as { get?: unknown; subscribe?: unknown }
  return typeof candidate.get === "function" && typeof candidate.subscribe === "function"
}

function buildRuntimeMatcher(matcher: (() => boolean) | ActionMapReactiveMatcher, source: string): RuntimeMatcher {
  if (typeof matcher === "function") {
    return {
      source,
      match: matcher,
      cacheable: false,
    }
  }

  if (isReactiveMatcher(matcher)) {
    return {
      source,
      match: () => matcher.get(),
      cacheable: true,
      subscribe: (onChange) => matcher.subscribe(onChange),
    }
  }

  throw new Error(`ActionMap ${source} expected a function or a reactive matcher`)
}

interface ResolvedCommandLookup {
  resolved?: ActionMapResolvedBindingCommand
  hadError: boolean
}

function createSyntheticCommandEvent(): KeyEvent {
  return new KeyEvent({
    name: "command",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
  })
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneCommandMetadataValue(value: unknown, options?: { freeze?: boolean }): unknown {
  const freeze = options?.freeze === true

  if (Array.isArray(value)) {
    const cloned = value.map((entry) => cloneCommandMetadataValue(entry, options))
    if (freeze) {
      return Object.freeze(cloned)
    }

    return cloned
  }

  if (value && typeof value === "object") {
    if (!isPlainObject(value)) {
      return value
    }

    const cloned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      cloned[key] = cloneCommandMetadataValue(entry, options)
    }

    if (freeze) {
      return Object.freeze(cloned)
    }

    return cloned
  }

  return value
}

function cloneCompileFieldValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value]
  }

  if (value && typeof value === "object") {
    return { ...(value as Record<string, unknown>) }
  }

  return value
}

function cloneParsedBindingInput(binding: ActionMapParsedBindingInput): ActionMapParsedBindingInput {
  return {
    ...binding,
    sequence: binding.sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)),
  }
}

function expandBindingInputWithExpanders(
  key: KeyLike,
  expanders: readonly ActionMapBindingExpander[],
  options?: {
    layer?: Readonly<Record<string, unknown>>
  },
): readonly KeyLike[] {
  if (typeof key !== "string" || expanders.length === 0) {
    return [key]
  }

  const layer = options?.layer ?? EMPTY_COMPILE_FIELDS
  let candidates = [key]

  for (const expander of expanders) {
    const nextCandidates: string[] = []

    for (const input of candidates) {
      const result = expander({ input, layer } satisfies ActionMapBindingExpanderContext)
      if (!result) {
        nextCandidates.push(input)
        continue
      }

      if (result.length === 0) {
        throw new Error(`ActionMap binding expander must return at least one key sequence for "${input}"`)
      }

      for (const expandedInput of result) {
        if (typeof expandedInput !== "string") {
          throw new Error(`ActionMap binding expander must return string key sequences for "${input}"`)
        }

        nextCandidates.push(expandedInput)
      }
    }

    candidates = nextCandidates
  }

  return candidates
}

function parseBindingSequenceWithParsers(
  key: string,
  parsers: readonly ActionMapBindingParser[],
  options?: {
    tokens?: ReadonlyMap<string, ParsedKeyToken>
    layer?: Readonly<Record<string, unknown>>
  },
): {
  parts: ParsedKeyPart[]
  usedTokens: readonly string[]
  unknownTokens: readonly string[]
  hasTokenBindings: boolean
} {
  if (key.length === 0) {
    throw new Error("Invalid key sequence: sequence cannot be empty")
  }

  if (parsers.length === 0) {
    throw new Error("No action map binding parsers are registered")
  }

  const tokens = options?.tokens ?? new Map<string, ParsedKeyToken>()
  const layer = options?.layer ?? EMPTY_COMPILE_FIELDS
  const parts: ParsedKeyPart[] = []
  const usedTokens = new Set<string>()
  const unknownTokens = new Set<string>()

  let index = 0
  while (index < key.length) {
    let matched = false

    for (const parser of parsers) {
      const result = parser({ input: key, index, layer, tokens } satisfies ActionMapBindingParserContext)
      if (!result) {
        continue
      }

      if (result.nextIndex <= index || result.nextIndex > key.length) {
        throw new Error(`ActionMap binding parser must advance the input for "${key}" at index ${index}`)
      }

      parts.push(...result.parts)
      for (const tokenName of result.usedTokens ?? []) {
        usedTokens.add(tokenName)
      }
      for (const tokenName of result.unknownTokens ?? []) {
        unknownTokens.add(tokenName)
      }

      index = result.nextIndex
      matched = true
      break
    }

    if (!matched) {
      throw new Error(`No action map binding parser handled input at index ${index} in "${key}"`)
    }
  }

  return {
    parts,
    usedTokens: [...usedTokens],
    unknownTokens: [...unknownTokens],
    hasTokenBindings: usedTokens.size > 0 || unknownTokens.size > 0,
  }
}

function parseSingleKeyPartWithParsers(
  key: KeyLike,
  parsers: readonly ActionMapBindingParser[],
  options?: {
    tokens?: ReadonlyMap<string, ParsedKeyToken>
    layer?: Readonly<Record<string, unknown>>
    parseObjectKey?: (key: KeyStroke) => ParsedKeyPart
  },
): ParsedKeyPart {
  if (typeof key !== "string") {
    const parseObjectKey = options?.parseObjectKey
    if (!parseObjectKey) {
      throw new Error("No action map binding syntax is registered")
    }

    return parseObjectKey(key)
  }

  // Tokens can be declared as strings or stroke objects. String tokens must use
  // the currently active parser chain (not a baked-in default parser), but token
  // substitution must still resolve to exactly one stroke.
  const { parts } = parseBindingSequenceWithParsers(key, parsers, options)
  const [part] = parts
  if (!part || parts.length !== 1) {
    throw new Error(`Invalid key "${String(key)}": expected a single key stroke`)
  }

  return part
}

export class ActionMap {
  public readonly renderer: CliRenderer

  private layers = new Set<RegisteredLayer>()
  private globalLayers: RegisteredLayer[] = []
  private targetLayers = new WeakMap<Renderable, RegisteredLayerBucket>()
  private tokens = new Map<string, ParsedKeyToken>()
  private bindingSyntax: ActionMapBindingSyntax | undefined
  private layerFields = new Map<string, ActionMapLayerFieldCompiler>()
  private bindingExpanders = new RegistrationList<ActionMapBindingExpander>()
  private bindingParsers = new RegistrationList<ActionMapBindingParser>()
  private bindingCompilers = new RegistrationList<ActionMapBindingCompiler>()
  private bindingFields = new Map<string, ActionMapBindingFieldCompiler>()
  private commandFields = new Map<string, ActionMapCommandFieldCompiler>()
  private runtimeKeyDependents = new Map<string, Set<RuntimeMatchable>>()
  private commandResolvers = new RegistrationList<ActionMapCommandResolver>()
  private eventMatchResolvers = new RegistrationList<ActionMapEventMatchResolver>()
  private keyHooks = new OrderedEmitter<(ctx: ActionMapKeyInputContext) => void, { priority: number; release: boolean }>()
  private rawHooks = new OrderedEmitter<(ctx: ActionMapRawInputContext) => void, { priority: number }>()
  // Reuse `Emitter`, but keep its `onError` hook as a no-op so throwing error
  // listeners cannot re-enter `emitError` and loop forever.
  private events = new Emitter<ActionMapEvents>(() => {})
  private hooks: Emitter<ActionMapHooks>
  private commands = new Map<string, RegisteredCommand>()
  private commandMetadataVersion = 0
  private layersWithConditions = 0
  private data: ActionMapEventData = {}
  private dataVersion = 0
  private readonlyDataVersion = -1
  private readonlyData: Readonly<ActionMapEventData> = Object.freeze({})
  private pendingSequence: PendingSequenceState | null = null
  private order = 0
  private destroyed = false
  private derivedStateVersion = 0
  private pendingSequenceCacheVersion = -1
  private pendingSequenceCache: readonly ParsedKeyStroke[] = []
  private pendingSequencePartsCacheVersion = -1
  private pendingSequencePartsCache: readonly ParsedKeyPart[] = []
  private activeKeysPlainCacheVersion = -1
  private activeKeysPlainCache: readonly ActionMapActiveKey[] = []
  private activeKeysBindingsCacheVersion = -1
  private activeKeysBindingsCache: readonly ActionMapActiveKey[] = []
  private activeKeysMetadataCacheVersion = -1
  private activeKeysMetadataCache: readonly ActionMapActiveKey[] = []
  private activeKeysBindingsAndMetadataCacheVersion = -1
  private activeKeysBindingsAndMetadataCache: readonly ActionMapActiveKey[] = []
  private stateChangeDepth = 0
  private stateChangePending = false
  private flushingStateChange = false
  private usedWarningKeys = new Set<string>()

  private readonly keypressListener: (event: KeyEvent) => void
  private readonly keyreleaseListener: (event: KeyEvent) => void
  private readonly rawListener: (sequence: string) => boolean
  private readonly focusedRenderableListener: (focused: Renderable | null) => void

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.hooks = new Emitter<ActionMapHooks>((name, error) => {
      this.reportHookError(name, error)
    })
    this.bindingSyntax = defaultBindingSyntax
    this.bindingParsers.append(defaultBindingParser)
    this.eventMatchResolvers.append(defaultEventMatchResolver)
    this.keypressListener = (event) => {
      this.handleKeyEvent(event, false)
    }
    this.keyreleaseListener = (event) => {
      this.handleKeyEvent(event, true)
    }
    this.rawListener = (sequence) => {
      return this.handleRawSequence(sequence)
    }
    this.focusedRenderableListener = (focused) => {
      this.handleFocusedRenderableChange(focused)
    }

    this.renderer.keyInput.prependListener("keypress", this.keypressListener)
    this.renderer.keyInput.prependListener("keyrelease", this.keyreleaseListener)
    this.renderer.prependInputHandler(this.rawListener)
    this.renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, this.focusedRenderableListener)
  }

  public get isDestroyed(): boolean {
    return this.destroyed
  }

  public destroy(): void {
    if (this.destroyed) {
      return
    }

    this.setPendingSequence(null)

    for (const layer of this.layers) {
      // Drop matcher subscriptions before clearing layer state.
      this.unregisterRuntimeMatchable(layer)
      for (const binding of layer.compiledBindings) {
        this.unregisterRuntimeMatchable(binding)
      }

      layer.offTargetDestroy?.()
      layer.offTargetDestroy = undefined
      layer.bucket = undefined
    }

    this.destroyed = true
    this.layers.clear()
    this.globalLayers = []
    this.targetLayers = new WeakMap()
    this.tokens.clear()
    this.bindingSyntax = undefined
    this.layerFields.clear()
    this.bindingExpanders.clear()
    this.bindingParsers.clear()
    this.bindingCompilers.clear()
    this.bindingFields.clear()
    this.commandFields.clear()
    this.runtimeKeyDependents.clear()
    this.commandResolvers.clear()
    this.eventMatchResolvers.clear()
    this.keyHooks.clear()
    this.rawHooks.clear()
    this.hooks.clear()
    this.commands.clear()
    this.commandMetadataVersion = 0
    this.layersWithConditions = 0
    this.data = {}
    this.dataVersion = 0
    this.readonlyDataVersion = -1
    this.readonlyData = Object.freeze({})
    this.derivedStateVersion = 0
    this.pendingSequenceCacheVersion = -1
    this.pendingSequenceCache = []
    this.pendingSequencePartsCacheVersion = -1
    this.pendingSequencePartsCache = []
    this.activeKeysPlainCacheVersion = -1
    this.activeKeysPlainCache = []
    this.activeKeysBindingsCacheVersion = -1
    this.activeKeysBindingsCache = []
    this.activeKeysMetadataCacheVersion = -1
    this.activeKeysMetadataCache = []
    this.activeKeysBindingsAndMetadataCacheVersion = -1
    this.activeKeysBindingsAndMetadataCache = []
    this.stateChangeDepth = 0
    this.stateChangePending = false
    this.flushingStateChange = false
    this.usedWarningKeys.clear()
    this.events.clear()

    this.renderer.keyInput.off("keypress", this.keypressListener)
    this.renderer.keyInput.off("keyrelease", this.keyreleaseListener)
    this.renderer.removeInputHandler(this.rawListener)
    this.renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, this.focusedRenderableListener)
  }

  public setData(name: string, value: unknown): void {
    if (this.destroyed) {
      return
    }

    this.runWithStateChangeBatch(() => {
      if (value === undefined) {
        if (!(name in this.data)) {
          return
        }

        delete this.data[name]
        this.dataVersion += 1
        this.invalidateRuntimeConditionKey(name)
        this.ensureValidPendingSequence()
        this.queueStateChange()
        return
      }

      if (Object.is(this.data[name], value)) {
        return
      }

      this.data[name] = value
      this.dataVersion += 1
      this.invalidateRuntimeConditionKey(name)
      this.ensureValidPendingSequence()
      this.queueStateChange()
    })
  }

  public getData(name: string): unknown {
    if (this.destroyed) {
      return undefined
    }

    return this.data[name]
  }

  public hasPendingSequence(): boolean {
    if (this.destroyed) {
      return false
    }

    return this.ensureValidPendingSequence() !== undefined
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    if (this.destroyed) {
      return []
    }

    if (this.pendingSequenceCacheVersion === this.derivedStateVersion) {
      return this.pendingSequenceCache
    }

    const pending = this.ensureValidPendingSequence()
    const canUseCache = !pending || this.layerCanCacheActiveKeys(pending.layer)

    const sequence = pending ? this.collectSequenceStrokesFromNode(pending.node) : []

    if (canUseCache) {
      this.pendingSequenceCacheVersion = this.derivedStateVersion
      this.pendingSequenceCache = sequence
    }

    return sequence
  }

  public getPendingSequenceParts(): readonly ParsedKeyPart[] {
    if (this.destroyed) {
      return []
    }

    if (this.pendingSequencePartsCacheVersion === this.derivedStateVersion) {
      return this.pendingSequencePartsCache
    }

    const pending = this.ensureValidPendingSequence()
    const canUseCache = !pending || this.layerCanCacheActiveKeys(pending.layer)

    const parts = pending ? this.collectSequencePartsFromNode(pending.node) : []

    if (canUseCache) {
      this.pendingSequencePartsCacheVersion = this.derivedStateVersion
      this.pendingSequencePartsCache = parts
    }

    return parts
  }

  public clearPendingSequence(): void {
    if (this.destroyed) {
      return
    }

    this.setPendingSequence(null)
  }

  public popPendingSequence(): boolean {
    if (this.destroyed) {
      return false
    }

    const pending = this.ensureValidPendingSequence()
    if (!pending) {
      return false
    }

    if (pending.node.depth <= 1) {
      this.setPendingSequence(null)
      return true
    }

    const parent = pending.node.parent
    if (!parent || !parent.stroke) {
      this.setPendingSequence(null)
      return true
    }

    this.setPendingSequence({
      layer: pending.layer,
      node: parent,
    })
    return true
  }

  public getActiveKeys(options?: ActionMapActiveKeyOptions): readonly ActionMapActiveKey[] {
    if (this.destroyed) {
      return []
    }

    const includeBindings = options?.includeBindings === true
    const includeMetadata = options?.includeMetadata === true

    if (includeBindings) {
      if (includeMetadata) {
        if (this.activeKeysBindingsAndMetadataCacheVersion === this.derivedStateVersion) {
          return this.activeKeysBindingsAndMetadataCache
        }
      } else if (this.activeKeysBindingsCacheVersion === this.derivedStateVersion) {
        return this.activeKeysBindingsCache
      }
    } else if (includeMetadata) {
      if (this.activeKeysMetadataCacheVersion === this.derivedStateVersion) {
        return this.activeKeysMetadataCache
      }
    } else if (this.activeKeysPlainCacheVersion === this.derivedStateVersion) {
      return this.activeKeysPlainCache
    }

    const focused = this.getFocusedRenderable()
    const pending = this.ensureValidPendingSequence()
    let activeLayers: RegisteredLayer[] = []
    if (!pending) {
      activeLayers = this.getActiveLayers(focused)
    }

    let canUseCache = false

    if (pending) {
      canUseCache = this.layerCanCacheActiveKeys(pending.layer)
    } else {
      canUseCache = this.activeLayersCanCacheActiveKeys(activeLayers)
    }

    let activeKeys: readonly ActionMapActiveKey[]

    if (pending) {
      activeKeys = this.collectActiveKeysFromChildren(pending.node.children, includeBindings, includeMetadata)
    } else {
      activeKeys = this.collectActiveKeysAtRoot(activeLayers, includeBindings, includeMetadata)
    }

    if (!canUseCache) {
      return activeKeys
    }

    if (includeBindings) {
      if (includeMetadata) {
        this.activeKeysBindingsAndMetadataCacheVersion = this.derivedStateVersion
        this.activeKeysBindingsAndMetadataCache = activeKeys
      } else {
        this.activeKeysBindingsCacheVersion = this.derivedStateVersion
        this.activeKeysBindingsCache = activeKeys
      }
    } else if (includeMetadata) {
      this.activeKeysMetadataCacheVersion = this.derivedStateVersion
      this.activeKeysMetadataCache = activeKeys
    } else {
      this.activeKeysPlainCacheVersion = this.derivedStateVersion
      this.activeKeysPlainCache = activeKeys
    }

    return activeKeys
  }

  public getCommands(query?: ActionMapCommandQuery): readonly ActionMapCommandRecord[] {
    if (this.destroyed) {
      return []
    }

    return queryRegisteredCommands({
      commands: this.commands.values(),
      query,
      getCommandRecord: (command) => this.getCommandRecord(command),
      onFilterError: (error) => {
        this.emitError("[ActionMap] Error in command query filter:", error)
      },
    })
  }

  public runCommand(cmd: string, options?: ActionMapRunCommandOptions): ActionMapRunCommandResult {
    if (this.destroyed) {
      return { ok: false, reason: "error" }
    }

    let normalized: ActionMapBindingCommand | undefined

    try {
      normalized = normalizeBindingCommand(cmd)
    } catch {
      return { ok: false, reason: "invalid-args" }
    }

    if (typeof normalized !== "string") {
      return { ok: false, reason: "not-found" }
    }

    const includeRecord = options?.includeCommand === true
    let resolved: ActionMapResolvedBindingCommand | undefined

    if (!this.commandResolvers.has()) {
      const registered = this.commands.get(normalized)
      if (!registered) {
        return { ok: false, reason: "not-found" }
      }

      resolved = this.getResolvedRegisteredCommand(registered, { includeRecord })
    } else {
      const lookup = this.resolveCommandString(normalized, { includeRecord })
      resolved = lookup.resolved
      if (!resolved) {
        if (lookup.hadError) {
          return { ok: false, reason: "error" }
        }

        return { ok: false, reason: "not-found" }
      }
    }

    const event = options?.event ?? createSyntheticCommandEvent()
    const context: ActionMapCommandContext = {
      actionMap: this,
      event,
      focused: options?.focused ?? this.getFocusedRenderable(),
      target: options?.target ?? null,
      data: this.getReadonlyData(),
    }

    let result: ActionMapCommandResult
    try {
      result = resolved.run(context)
    } catch (error) {
      this.emitError(`[ActionMap] Error running command "${normalized}":`, error)
      if (resolved.record) {
        return { ok: false, reason: "error", command: resolved.record }
      }

      return { ok: false, reason: "error" }
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        this.emitError(`[ActionMap] Async error in command "${normalized}":`, error)
      })
      return resolved.record ? { ok: true, command: resolved.record } : { ok: true }
    }

    if (result === false) {
      if (resolved.rejectedResult) {
        return resolved.rejectedResult
      }

      if (resolved.record) {
        return { ok: false, reason: "rejected", command: resolved.record }
      }

      return { ok: false, reason: "rejected" }
    }

    return resolved.record ? { ok: true, command: resolved.record } : { ok: true }
  }

  public hook<TName extends ActionMapHookName>(name: TName, fn: ActionMapHookListener<ActionMapHooks[TName]>): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.hooks.hook(name, fn)
  }

  public on<TName extends keyof ActionMapEvents>(
    name: TName,
    fn: EmitterListener<ActionMapEvents[TName]>,
  ): this {
    if (this.destroyed) {
      return this
    }

    this.events.hook(name, fn)
    return this
  }

  public off<TName extends keyof ActionMapEvents>(
    name: TName,
    fn: EmitterListener<ActionMapEvents[TName]>,
  ): this {
    this.events.off(name, fn)
    return this
  }

  public registerLayer(layer: ActionMapLayer): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.runWithStateChangeBatch(() => {
      const target = layer.target
      if (target && target.isDestroyed) {
        this.emitError("Cannot register an action map layer for a destroyed renderable")
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
        this.emitError(getErrorMessage(error, "Failed to register action map layer"), error)
        return NOOP
      }

      const order = this.order++
      const compiledBindings = this.compileBindings(bindingInputs, this.tokens, scope, target, order, compileFields)

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

      this.layers.add(registeredLayer)
      if (registeredLayer.requires.length > 0 || registeredLayer.matchers.length > 0) {
        this.layersWithConditions += 1
      }
      this.registerRuntimeMatchable(registeredLayer)
      for (const binding of registeredLayer.compiledBindings) {
        this.registerRuntimeMatchable(binding)
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

      this.queueStateChange()

      return () => {
        this.unregisterLayer(registeredLayer)
      }
    })
  }

  public registerLayerFields(fields: Record<string, ActionMapLayerFieldCompiler>): () => void {
    if (this.destroyed) {
      return NOOP
    }

    const entries = Object.entries(fields)
    const registered: Array<[string, ActionMapLayerFieldCompiler]> = []

    for (const [name] of entries) {
      if (RESERVED_LAYER_FIELDS.has(name)) {
        this.emitError(`ActionMap layer field "${name}" is reserved`)
        continue
      }

      if (this.layerFields.has(name)) {
        this.emitError(`ActionMap layer field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      if (RESERVED_LAYER_FIELDS.has(name) || this.layerFields.has(name)) {
        continue
      }

      this.layerFields.set(name, compiler)
      registered.push([name, compiler])
    }

    return () => {
      for (const [name, compiler] of registered) {
        const current = this.layerFields.get(name)
        if (current === compiler) {
          this.layerFields.delete(name)
        }
      }
    }
  }

  public registerBindingCompiler(compiler: ActionMapBindingCompiler): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.bindingCompilers.append(compiler)
  }

  public prependBindingParser(parser: ActionMapBindingParser): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.bindingParsers.prepend(parser)
  }

  public appendBindingParser(parser: ActionMapBindingParser): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.bindingParsers.append(parser)
  }

  public clearBindingParsers(): void {
    if (this.destroyed) {
      return
    }

    this.bindingParsers.clear()
  }

  public setBindingSyntax(syntax: ActionMapBindingSyntax): void {
    if (this.destroyed) {
      return
    }

    this.bindingSyntax = syntax
  }

  public clearBindingSyntax(): void {
    if (this.destroyed) {
      return
    }

    this.bindingSyntax = undefined
  }

  public registerToken(token: ActionMapToken): () => void {
    if (this.destroyed) {
      return NOOP
    }

    let normalizedToken: string

    try {
      normalizedToken = this.normalizeTokenName(token.name)
    } catch (error) {
      this.emitError(getErrorMessage(error, "Failed to register action map token"), error)
      return NOOP
    }

    if (this.tokens.has(normalizedToken)) {
      this.emitError(`ActionMap token "${normalizedToken}" is already registered`)
      return NOOP
    }

    let parsedToken: ParsedKeyPart

    try {
      parsedToken = parseSingleKeyPartWithParsers(token.key, this.bindingParsers.snapshot(), {
        tokens: this.tokens,
        layer: EMPTY_COMPILE_FIELDS,
        parseObjectKey: (key) => this.parseObjectKeyPart(key),
      })
    } catch (error) {
      this.emitError(getErrorMessage(error, `Failed to register action map token "${normalizedToken}"`), error)
      return NOOP
    }

    const registeredToken: ParsedKeyToken = {
      stroke: parsedToken.stroke,
      matchKey: parsedToken.matchKey,
    }

    const nextTokens = new Map(this.tokens)
    nextTokens.set(normalizedToken, registeredToken)

    try {
      this.applyTokenState(nextTokens)
    } catch (error) {
      this.emitError(getErrorMessage(error, `Failed to register action map token "${normalizedToken}"`), error)
      return NOOP
    }

    return () => {
      const current = this.tokens.get(normalizedToken)
      if (current === registeredToken) {
        const nextTokens = new Map(this.tokens)
        nextTokens.delete(normalizedToken)

        try {
          this.applyTokenState(nextTokens)
        } catch (error) {
          this.emitError(getErrorMessage(error, `Failed to unregister action map token "${normalizedToken}"`), error)
        }
      }
    }
  }

  public prependBindingExpander(expander: ActionMapBindingExpander): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.bindingExpanders.prepend(expander)
  }

  public appendBindingExpander(expander: ActionMapBindingExpander): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.bindingExpanders.append(expander)
  }

  public clearBindingExpanders(): void {
    if (this.destroyed) {
      return
    }

    this.bindingExpanders.clear()
  }

  public registerBindingFields(fields: Record<string, ActionMapBindingFieldCompiler>): () => void {
    if (this.destroyed) {
      return NOOP
    }

    const entries = Object.entries(fields)
    const registered: Array<[string, ActionMapBindingFieldCompiler]> = []

    for (const [name] of entries) {
      if (RESERVED_BINDING_FIELDS.has(name)) {
        this.emitError(`ActionMap binding field "${name}" is reserved`)
        continue
      }

      if (this.bindingFields.has(name)) {
        this.emitError(`ActionMap binding field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      if (RESERVED_BINDING_FIELDS.has(name) || this.bindingFields.has(name)) {
        continue
      }

      this.bindingFields.set(name, compiler)
      registered.push([name, compiler])
    }

    return () => {
      for (const [name, compiler] of registered) {
        const current = this.bindingFields.get(name)
        if (current === compiler) {
          this.bindingFields.delete(name)
        }
      }
    }
  }

  public registerCommandFields(fields: Record<string, ActionMapCommandFieldCompiler>): () => void {
    if (this.destroyed) {
      return NOOP
    }

    const entries = Object.entries(fields)
    const registered: Array<[string, ActionMapCommandFieldCompiler]> = []

    for (const [name] of entries) {
      if (RESERVED_COMMAND_FIELDS.has(name)) {
        this.emitError(`ActionMap command field "${name}" is reserved`)
        continue
      }

      if (this.commandFields.has(name)) {
        this.emitError(`ActionMap command field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      if (RESERVED_COMMAND_FIELDS.has(name) || this.commandFields.has(name)) {
        continue
      }

      this.commandFields.set(name, compiler)
      registered.push([name, compiler])
    }

    return () => {
      for (const [name, compiler] of registered) {
        const current = this.commandFields.get(name)
        if (current === compiler) {
          this.commandFields.delete(name)
        }
      }
    }
  }

  public registerCommandResolver(resolver: ActionMapCommandResolver): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.runWithStateChangeBatch(() => {
      this.commandResolvers.append(resolver)
      this.refreshBindingCommandResolution()
      this.queueStateChange()

      return () => {
        this.runWithStateChangeBatch(() => {
          if (!this.commandResolvers.remove(resolver)) {
            return
          }

          this.refreshBindingCommandResolution()
          this.queueStateChange()
        })
      }
    })
  }

  public registerEventMatchResolver(resolver: ActionMapEventMatchResolver): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.eventMatchResolvers.append(resolver)
  }

  public clearEventMatchResolvers(): void {
    if (this.destroyed) {
      return
    }

    this.eventMatchResolvers.clear()
  }

  public onKeyInput(
    fn: (ctx: ActionMapKeyInputContext) => void,
    options?: { priority?: number; release?: boolean },
  ): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.keyHooks.hook(fn, {
      priority: options?.priority ?? 0,
      release: options?.release ?? false,
    })
  }

  public onRawInput(fn: (ctx: ActionMapRawInputContext) => void, options?: { priority?: number }): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.rawHooks.hook(fn, {
      priority: options?.priority ?? 0,
    })
  }

  public registerCommands(commands: ActionMapCommandDefinition[]): () => void {
    if (this.destroyed) {
      return NOOP
    }

    return this.runWithStateChangeBatch(() => {
      const normalizedCommands: RegisteredCommand[] = []
      const seen = new Set<string>()

      for (const command of commands) {
        let normalizedCommand: RegisteredCommand | undefined

        try {
          const mergedAttrs: ActionMapAttributes = {}
          const mergedFields: Record<string, unknown> = {}
          const normalizedName = normalizeCommandName(command.name)

          if (seen.has(normalizedName)) {
            this.emitError(`Duplicate action map command "${normalizedName}" in the same registration batch`)
            continue
          }

          if (this.commands.has(normalizedName)) {
            this.emitError(`ActionMap command "${normalizedName}" is already registered`)
            continue
          }

          for (const [fieldName, value] of Object.entries(command)) {
            if (RESERVED_COMMAND_FIELDS.has(fieldName)) {
              continue
            }

            if (value === undefined) {
              continue
            }

            mergedFields[fieldName] = cloneCommandMetadataValue(value)

            const compiler = this.commandFields.get(fieldName)
            if (!compiler) {
              continue
            }

            compiler(value, {
              attr(name, attributeValue) {
                mergeAttribute(mergedAttrs, name, cloneCommandMetadataValue(attributeValue), `field ${fieldName}`)
              },
            })
          }

          const attrs = Object.keys(mergedAttrs).length === 0 ? undefined : Object.freeze(mergedAttrs)
          const fields = Object.keys(mergedFields).length === 0 ? EMPTY_COMMAND_FIELDS : Object.freeze(mergedFields)

          normalizedCommand = {
            name: normalizedName,
            fields,
            run: command.run,
          }

          if (attrs) {
            normalizedCommand.attrs = attrs
          }
        } catch (error) {
          this.emitError(getErrorMessage(error, `Failed to register action map command "${String(command.name)}"`), error)
          continue
        }

        seen.add(normalizedCommand.name)
        normalizedCommands.push(normalizedCommand)
      }

      for (const command of normalizedCommands) {
        this.commands.set(command.name, command)
      }

      if (normalizedCommands.length > 0) {
        this.refreshBindingCommandResolution()
        this.queueStateChange()
      }

      return () => {
        this.runWithStateChangeBatch(() => {
          let removed = false

          for (const command of normalizedCommands) {
            const current = this.commands.get(command.name)
            if (current !== command) {
              continue
            }

            this.commands.delete(command.name)
            removed = true
          }

          if (removed) {
            this.refreshBindingCommandResolution()
            this.queueStateChange()
          }
        })
      }
    })
  }

  private handleFocusedRenderableChange(_focused: Renderable | null): void {
    this.runWithStateChangeBatch(() => {
      // Any focus change breaks a pending sequence. Prefix dispatch is captured
      // against the state that started it, and changing focus can change the
      // active bindings and their precedence.
      this.setPendingSequence(null)
      this.queueStateChange()
    })
  }

  private runWithStateChangeBatch<T>(fn: () => T): T {
    this.stateChangeDepth += 1

    try {
      return fn()
    } finally {
      this.stateChangeDepth -= 1
      if (this.stateChangeDepth === 0) {
        this.flushStateChange()
      }
    }
  }

  private queueStateChange(): void {
    this.derivedStateVersion += 1

    if (!this.hooks.has("state")) {
      return
    }

    this.stateChangePending = true
    if (this.stateChangeDepth === 0 && !this.flushingStateChange) {
      this.flushStateChange()
    }
  }

  private flushStateChange(): void {
    if (!this.stateChangePending || this.stateChangeDepth > 0 || this.flushingStateChange) {
      return
    }

    this.flushingStateChange = true

    try {
      while (this.stateChangePending && this.stateChangeDepth === 0) {
        this.stateChangePending = false
        this.hooks.emit("state")
      }
    } finally {
      this.flushingStateChange = false
    }
  }

  private emitWarning(message: string): void {
    if (!this.events.has("warning")) {
      console.warn(message)
      return
    }

    this.events.emit("warning", { message })
  }

  private emitError(message: string, cause?: unknown): void {
    if (!this.events.has("error")) {
      if (cause === undefined) {
        console.error(message)
      } else {
        console.error(message, cause)
      }
      return
    }

    const event: ActionMapErrorEvent = cause === undefined ? { message } : { message, cause }
    this.events.emit("error", event)
  }

  private reportHookError(name: ActionMapHookName, error: unknown): void {
    if (name === "state") {
      this.emitError("[ActionMap] Error in state change hook:", error)
      return
    }

    if (name === "pendingSequence") {
      this.emitError("[ActionMap] Error in pending sequence hook:", error)
      return
    }

    this.emitError("[ActionMap] Error in unresolved command hook:", error)
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

  private compileLayerRuntimeState(layer: ActionMapLayer): {
    requires: readonly [name: string, value: unknown][]
    matchers: readonly RuntimeMatcher[]
    conditionKeys: readonly string[]
    hasUnkeyedMatchers: boolean
    compileFields?: Readonly<Record<string, unknown>>
  } {
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

      compileFields[fieldName] = cloneCompileFieldValue(value)

      const compiler = this.layerFields.get(fieldName)
      if (!compiler) {
        this.warnUnknownField("layer", fieldName)
        continue
      }

      compiler(value, {
        require(name, requiredValue) {
          mergeRequirement(mergedRequires, name, requiredValue, `field ${fieldName}`)
          conditionKeys.add(name)
        },
        match(matcher) {
          const runtimeMatcher = buildRuntimeMatcher(matcher, `field ${fieldName}`)
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
    const existing = this.targetLayers.get(target)
    if (existing) {
      return existing
    }

    const bucket: RegisteredLayerBucket = {
      focusLayers: [],
      focusWithinLayers: [],
    }
    this.targetLayers.set(target, bucket)
    return bucket
  }

  private indexLayer(layer: RegisteredLayer): void {
    if (layer.scope === "global") {
      this.globalLayers = sortByPriorityAndOrder([...this.globalLayers, layer], { order: "desc" })
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
      this.globalLayers = this.globalLayers.filter((candidate) => candidate !== layer)
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
      this.targetLayers.delete(target)
    }

    layer.bucket = undefined
  }

  private unregisterLayer(layer: RegisteredLayer): void {
    this.runWithStateChangeBatch(() => {
      if (!this.layers.delete(layer)) {
        return
      }

      if (layer.requires.length > 0 || layer.matchers.length > 0) {
        this.layersWithConditions -= 1
      }

      this.unregisterRuntimeMatchable(layer)
      for (const binding of layer.compiledBindings) {
        this.unregisterRuntimeMatchable(binding)
      }

      this.removeLayerFromIndex(layer)
      layer.offTargetDestroy?.()
      layer.offTargetDestroy = undefined

      if (this.pendingSequence?.layer === layer) {
        this.setPendingSequence(null)
      }

      this.queueStateChange()
    })
  }

  private applyTokenState(nextTokens: Map<string, ParsedKeyToken>): void {
    this.runWithStateChangeBatch(() => {
      const nextCompilations = new Map<RegisteredLayer, CompiledBindingsResult>()

      for (const layer of this.layers) {
        if (!layer.hasTokenBindings) {
          continue
        }

        nextCompilations.set(
          layer,
          this.compileBindings(
            layer.bindingInputs,
            nextTokens,
            layer.scope,
            layer.target,
            layer.order,
            layer.compileFields,
          ),
        )
      }

      this.tokens = nextTokens

      let shouldClearPending = false
      for (const [layer, compilation] of nextCompilations) {
        for (const binding of layer.compiledBindings) {
          this.unregisterRuntimeMatchable(binding)
        }

        layer.root = compilation.root
        layer.compiledBindings = compilation.bindings

        for (const binding of layer.compiledBindings) {
          this.registerRuntimeMatchable(binding)
        }

        if (this.pendingSequence?.layer === layer) {
          shouldClearPending = true
        }
      }

      if (shouldClearPending) {
        this.setPendingSequence(null)
      }

      if (nextCompilations.size > 0) {
        this.queueStateChange()
      }
    })
  }

  private refreshBindingCommandResolution(): void {
    for (const layer of this.layers) {
      for (const binding of layer.compiledBindings) {
        this.resolveCompiledBindingCommand(binding)
      }
    }

    this.commandMetadataVersion += 1
    this.ensureValidPendingSequence()
  }

  private resolveCompiledBindingCommand(binding: CompiledBinding): void {
    binding.run = undefined
    binding.commandAttrs = undefined
    binding.activeBindingCacheVersion = undefined
    binding.activeBindingCache = undefined

    const command = binding.command
    if (command === undefined) {
      return
    }

    if (typeof command === "function") {
      binding.run = command
      return
    }

    if (!this.commandResolvers.has()) {
      const registered = this.commands.get(command)
      if (!registered) {
        this.handleUnresolvedCommand(command, binding)
        return
      }

      const resolved = this.getResolvedRegisteredCommand(registered)
      binding.run = resolved.run
      binding.commandAttrs = resolved.attrs
      return
    }

    const lookup = this.resolveCommandString(command)
    const resolved = lookup.resolved
    if (!resolved) {
      if (!lookup.hadError) {
        this.handleUnresolvedCommand(command, binding)
      }

      return
    }

    binding.run = resolved.run
    binding.commandAttrs = resolved.attrs
  }

  private resolveCommandString(command: string, options?: { includeRecord?: boolean }): ResolvedCommandLookup {
    const includeRecord = options?.includeRecord === true
    const context = this.createCommandResolverContext(includeRecord)
    let hadError = false

    for (const resolver of this.commandResolvers.snapshot()) {
      let resolved: ActionMapResolvedBindingCommand | undefined

      try {
        resolved = resolver(command, context)
      } catch (error) {
        hadError = true
        this.emitError(`[ActionMap] Error in command resolver for "${command}":`, error)
        continue
      }

      if (resolved) {
        return { hadError, resolved }
      }
    }

    const registered = this.commands.get(command)
    if (registered) {
      return {
        hadError,
        resolved: this.getResolvedRegisteredCommand(registered, { includeRecord }),
      }
    }

    return { hadError }
  }

  private createCommandResolverContext(includeRecord: boolean): ActionMapCommandResolverContext {
    return {
      getCommandAttrs: (name) => {
        return this.commands.get(name)?.attrs
      },
      getCommandRecord: (name) => {
        if (!includeRecord) {
          return undefined
        }

        const registered = this.commands.get(name)
        if (!registered) {
          return undefined
        }

        return this.getCommandRecord(registered)
      },
    }
  }

  private getResolvedRegisteredCommand(
    command: RegisteredCommand,
    options?: { includeRecord?: boolean },
  ): ActionMapResolvedBindingCommand {
    const includeRecord = options?.includeRecord === true
    if (includeRecord) {
      const existing = command.resolvedWithRecord
      if (existing) {
        return existing
      }

      const resolved: ActionMapResolvedBindingCommand = {
        run: this.createRegisteredCommandRunner(command),
      }

      if (command.attrs) {
        resolved.attrs = command.attrs
      }

      resolved.record = this.getCommandRecord(command)
      command.resolvedWithRecord = resolved
      return resolved
    }

    const existing = command.resolved
    if (existing) {
      return existing
    }

    const resolved: ActionMapResolvedBindingCommand = {
      run: this.createRegisteredCommandRunner(command),
    }

    if (command.attrs) {
      resolved.attrs = command.attrs
    }

    command.resolved = resolved
    return resolved
  }

  private createRegisteredCommandRunner(command: RegisteredCommand): ActionMapCommandHandler {
    if (command.runner) {
      return command.runner
    }

    const runner: ActionMapCommandHandler = (ctx) => {
      return command.run({
        ...ctx,
        command: this.getCommandRecord(command),
      })
    }

    command.runner = runner
    return runner
  }

  private getCommandRecord(command: RegisteredCommand): ActionMapCommandRecord {
    if (command.record) {
      return command.record
    }

    let fields = EMPTY_COMMAND_FIELDS
    if (command.fields !== EMPTY_COMMAND_FIELDS) {
      fields = cloneCommandMetadataValue(command.fields, { freeze: true }) as Readonly<Record<string, unknown>>
    }

    let record: ActionMapCommandRecord
    if (command.attrs) {
      record = Object.freeze({
        name: command.name,
        fields,
        attrs: cloneCommandMetadataValue(command.attrs, { freeze: true }) as Readonly<ActionMapAttributes>,
      })
    } else {
      record = Object.freeze({
        name: command.name,
        fields,
      })
    }

    command.record = record
    return record
  }

  private getBindingSyntax(): ActionMapBindingSyntax {
    const syntax = this.bindingSyntax
    if (!syntax) {
      throw new Error("No action map binding syntax is registered")
    }

    return syntax
  }

  private normalizeTokenName(token: string): string {
    const normalized = this.getBindingSyntax().normalizeTokenName(token)
    if (!normalized) {
      throw new Error("Invalid action map token: token cannot be empty")
    }

    return normalized
  }

  private parseObjectKeyPart(key: KeyStroke): ParsedKeyPart {
    const parsed = this.getBindingSyntax().parseObjectKey(key)
    return createParsedKeyPart(parsed.stroke, parsed.display, parsed.matchKey)
  }

  private normalizeBindingEvent(event: unknown): ActionMapBindingEvent {
    if (event === undefined || event === "press") {
      return "press"
    }

    if (event === "release") {
      return "release"
    }

    throw new Error(`Invalid action map binding event "${String(event)}": expected "press" or "release"`)
  }

  private compileBindings(
    bindings: readonly ActionMapBindingInput[],
    tokens: ReadonlyMap<string, ParsedKeyToken>,
    sourceScope: ActionMapScope,
    sourceTarget: Renderable | undefined,
    sourceLayerOrder: number,
    compileFields?: Readonly<Record<string, unknown>>,
  ): CompiledBindingsResult {
    const root = createSequenceNode(null, null, null)
    const compiledBindings: CompiledBinding[] = []
    let hasTokenBindings = false
    const bindingExpanders = this.bindingExpanders.snapshot()
    const bindingParsers = this.bindingParsers.snapshot()

    for (const [bindingIndex, binding] of bindings.entries()) {
      let expandedBindingKeys: readonly KeyLike[]

      try {
        expandedBindingKeys = expandBindingInputWithExpanders(binding.key, bindingExpanders, {
          layer: compileFields,
        })
      } catch (error) {
        this.emitError(getErrorMessage(error, "Failed to expand action map binding"), error)
        continue
      }

      for (const expandedBindingKey of expandedBindingKeys) {
        let parsed:
          | {
              parts: ParsedKeyPart[]
              usedTokens: readonly string[]
              unknownTokens: readonly string[]
              hasTokenBindings: boolean
            }
          | undefined

        try {
          parsed =
            typeof expandedBindingKey === "string"
              ? parseBindingSequenceWithParsers(expandedBindingKey, bindingParsers, {
                  tokens,
                  layer: compileFields,
                })
              : {
                  parts: [this.parseObjectKeyPart(expandedBindingKey)],
                  usedTokens: [] as readonly string[],
                  unknownTokens: [] as readonly string[],
                  hasTokenBindings: false,
                }
        } catch (error) {
          this.emitError(getErrorMessage(error, "Failed to parse action map binding"), error)
          continue
        }

        const sequence = parsed.parts
        hasTokenBindings ||= parsed.hasTokenBindings

        for (const tokenName of parsed.unknownTokens) {
          this.warnUnknownToken(
            tokenName,
            typeof expandedBindingKey === "string" ? expandedBindingKey : String(expandedBindingKey.name),
          )
        }

        for (const compiledInput of this.expandParsedBindings(binding, sequence, compileFields)) {
          try {
            const event = this.normalizeBindingEvent(compiledInput.event)
            const mergedRequires: ActionMapEventData = {}
            const mergedAttrs: ActionMapAttributes = {}
            const matchers: RuntimeMatcher[] = []
            const conditionKeys = new Set<string>()
            let hasUnkeyedMatchers = false

            const { sequence, ...bindingFields } = compiledInput

            for (const [fieldName, value] of Object.entries(bindingFields)) {
              if (RESERVED_BINDING_FIELDS.has(fieldName)) {
                continue
              }

              if (value === undefined) {
                continue
              }

              const compiler = this.bindingFields.get(fieldName)
              if (!compiler) {
                this.warnUnknownField("binding", fieldName)
                continue
              }

              compiler(value, {
                require(name, requiredValue) {
                  mergeRequirement(mergedRequires, name, requiredValue, `field ${fieldName}`)
                  conditionKeys.add(name)
                },
                attr(name, attributeValue) {
                  mergeAttribute(mergedAttrs, name, attributeValue, `field ${fieldName}`)
                },
                match(matcher) {
                  const runtimeMatcher = buildRuntimeMatcher(matcher, `field ${fieldName}`)
                  if (!runtimeMatcher.cacheable) {
                    hasUnkeyedMatchers = true
                  }
                  matchers.push(runtimeMatcher)
                },
              })
            }

            const attrs = freezeAttributes(mergedAttrs)
            const command = normalizeBindingCommand(compiledInput.cmd)
            const compiledBinding: CompiledBinding = {
              sequence,
              command,
              event,
              sourceBinding: cloneParsedBindingInput(compiledInput),
              sourceScope,
              sourceTarget,
              sourceLayerOrder,
              sourceBindingIndex: bindingIndex,
              requires: Object.entries(mergedRequires),
              matchers,
              conditionKeys: [...conditionKeys],
              hasUnkeyedMatchers,
              matchCacheDirty: true,
              preventDefault: compiledInput.preventDefault !== false,
              fallthrough: compiledInput.fallthrough ?? false,
            }

            if (attrs) {
              compiledBinding.attrs = attrs
            }

            this.resolveCompiledBindingCommand(compiledBinding)

            if (sequence.length === 0) {
              continue
            }

            if (event === "release" && sequence.length > 1) {
              throw new Error("ActionMap release bindings only support a single key stroke")
            }

            if (event === "press") {
              this.insertBinding(root, compiledBinding)
            }

            compiledBindings.push(compiledBinding)
          } catch (error) {
            this.emitError(getErrorMessage(error, "Failed to compile action map binding"), error)
          }
        }
      }
    }

    return {
      root,
      bindings: compiledBindings,
      hasTokenBindings,
    }
  }

  private expandParsedBindings(
    binding: ActionMapBindingInput,
    sequence: ParsedKeyPart[],
    compileFields?: Readonly<Record<string, unknown>>,
  ): ActionMapParsedBindingInput[] {
    const bindingCompilers = this.bindingCompilers.snapshot()

    if (bindingCompilers.length === 0) {
      return [
        { ...binding, sequence: sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)) },
      ]
    }

    const parsedBinding: ActionMapParsedBindingInput = {
      ...binding,
      sequence: sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)),
    }
    const extraBindings: ActionMapParsedBindingInput[] = []
    let keepOriginal = true
    const layer = compileFields ?? EMPTY_COMPILE_FIELDS

    for (const compiler of bindingCompilers) {
      try {
        compiler(parsedBinding, {
          layer,
          add: (nextBinding) => {
            extraBindings.push(cloneParsedBindingInput(nextBinding))
          },
          skipOriginal: () => {
            keepOriginal = false
          },
        })
      } catch (error) {
        this.emitError("[ActionMap] Error in binding compiler:", error)
      }
    }

    if (!keepOriginal) {
      return extraBindings
    }

    if (extraBindings.length === 0) {
      return [parsedBinding]
    }

    return [parsedBinding, ...extraBindings]
  }

  private insertBinding(root: SequenceNode, binding: CompiledBinding): void {
    let node = root
    const touchedNodes: SequenceNode[] = []
    const createdNodes: Array<{ parent: SequenceNode; key: string }> = []

    try {
      for (const part of binding.sequence) {
        if (node.bindings.some((candidate) => candidate.command !== undefined)) {
          throw new Error(
            "ActionMap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
          )
        }

        const bindingKey = part.matchKey
        let child = node.children.get(bindingKey)
        if (!child) {
          child = createSequenceNode(node, part.stroke, part.matchKey)
          node.children.set(bindingKey, child)
          createdNodes.push({ parent: node, key: bindingKey })
        }

        child.reachableBindings.push(binding)
        touchedNodes.push(child)
        node = child
      }

      if (binding.command !== undefined && node.children.size > 0) {
        throw new Error(
          "ActionMap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
        )
      }

      node.bindings = [...node.bindings, binding]
    } catch (error) {
      for (let index = touchedNodes.length - 1; index >= 0; index -= 1) {
        const touchedNode = touchedNodes[index]
        if (!touchedNode) {
          continue
        }

        if (touchedNode.reachableBindings.at(-1) === binding) {
          touchedNode.reachableBindings.pop()
          continue
        }

        touchedNode.reachableBindings = touchedNode.reachableBindings.filter((candidate) => candidate !== binding)
      }

      for (let index = createdNodes.length - 1; index >= 0; index -= 1) {
        const createdNode = createdNodes[index]
        if (!createdNode) {
          continue
        }

        const child = createdNode.parent.children.get(createdNode.key)
        if (!child) {
          continue
        }

        if (child.children.size > 0 || child.reachableBindings.length > 0 || child.bindings.length > 0) {
          continue
        }

        createdNode.parent.children.delete(createdNode.key)
      }

      throw error
    }
  }

  private handleRawSequence(sequence: string): boolean {
    if (this.destroyed) {
      return false
    }

    const hooks = this.rawHooks.snapshot()
    if (hooks.length === 0) {
      return false
    }

    let stopped = false
    const context: ActionMapRawInputContext = {
      sequence,
      stop() {
        stopped = true
      },
    }

    for (const hook of hooks) {
      try {
        hook.listener(context)
      } catch (error) {
        this.emitError("[ActionMap] Error in raw input hook:", error)
      }

      if (stopped) {
        return true
      }
    }

    return false
  }

  private handleKeyEvent(event: KeyEvent, release: boolean): void {
    if (this.destroyed) {
      return
    }

    const hooks = this.keyHooks.snapshot()
    const context: ActionMapKeyInputContext = {
      event,
      setData: (name, value) => {
        this.setData(name, value)
      },
      getData: (name) => {
        return this.data[name]
      },
      consume: (options) => {
        const shouldPreventDefault = options?.preventDefault ?? true
        const shouldStopPropagation = options?.stopPropagation ?? true

        if (shouldPreventDefault) {
          event.preventDefault()
        }

        if (shouldStopPropagation) {
          event.stopPropagation()
        }
      },
    }

    for (const hook of hooks) {
      if (hook.release !== release) {
        continue
      }

      try {
        hook.listener(context)
      } catch (error) {
        this.emitError("[ActionMap] Error in key input hook:", error)
      }

      if (event.propagationStopped) {
        return
      }
    }

    if (release) {
      this.dispatchReleaseLayers(event)
      return
    }

    this.dispatchLayers(event)
  }

  private dispatchReleaseLayers(event: KeyEvent): void {
    const focused = this.getFocusedRenderable()
    const activeLayers = this.getActiveLayers(focused)
    const hasLayerConditions = this.layersWithConditions > 0
    const matchKeys = this.resolveEventMatchKeys(event)

    layerLoop: for (const layer of activeLayers) {
      if (hasLayerConditions && !this.hasNoConditions(layer) && !this.matchesConditions(layer)) {
        continue
      }

      for (const strokeKey of matchKeys) {
        const result = this.runReleaseBindings(layer, strokeKey, event, focused)
        if (!result.handled) {
          continue
        }

        if (result.stop) {
          return
        }

        continue layerLoop
      }
    }
  }

  private dispatchLayers(event: KeyEvent): void {
    const focused = this.getFocusedRenderable()
    const pending = this.ensureValidPendingSequence()
    const matchKeys = this.resolveEventMatchKeys(event)

    if (pending) {
      this.dispatchPendingSequence(pending, matchKeys, event, focused)
      return
    }

    const activeLayers = this.getActiveLayers(focused)
    this.dispatchFromRoot(activeLayers, matchKeys, event, focused)
  }

  private dispatchPendingSequence(
    pending: PendingSequenceState,
    matchKeys: readonly string[],
    event: KeyEvent,
    focused: Renderable | null,
  ): void {
    const nextNode = this.getReachableChild(pending.node, matchKeys)
    if (!nextNode) {
      this.setPendingSequence(null)
      return
    }

    if (nextNode.children.size > 0) {
      this.setPendingSequence({
        layer: pending.layer,
        node: nextNode,
      })
      event.preventDefault()
      event.stopPropagation()
      return
    }

    this.runBindings(pending.layer, nextNode.bindings, event, focused)
    this.setPendingSequence(null)
  }

  private dispatchFromRoot(
    activeLayers: RegisteredLayer[],
    matchKeys: readonly string[],
    event: KeyEvent,
    focused: Renderable | null,
  ): void {
    const hasLayerConditions = this.layersWithConditions > 0

    layerLoop: for (const layer of activeLayers) {
      if (hasLayerConditions && !this.hasNoConditions(layer) && !this.matchesConditions(layer)) {
        continue
      }

      const nextNode = this.getReachableChild(layer.root, matchKeys)
      if (!nextNode) {
        continue
      }

      if (nextNode.children.size > 0) {
        this.setPendingSequence({
          layer,
          node: nextNode,
        })
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const result = this.runBindings(layer, nextNode.bindings, event, focused)
      if (!result.handled) {
        continue
      }

      if (result.stop) {
        return
      }
      continue layerLoop
    }
  }

  private resolveEventMatchKeys(event: KeyEvent): string[] {
    const resolvers = this.eventMatchResolvers.snapshot()

    if (resolvers.length === 0) {
      return []
    }

    if (resolvers.length === 1) {
      const resolver = resolvers[0]!

      let resolved: readonly string[] | undefined
      try {
        resolved = resolver(event)
      } catch (error) {
        this.emitError("[ActionMap] Error in event match resolver:", error)
        return []
      }

      if (!resolved || resolved.length === 0) {
        return []
      }

      if (resolved.length === 1) {
        const [candidate] = resolved
        if (typeof candidate !== "string" || !candidate) {
          this.emitError("[ActionMap] Invalid event match resolver candidate:", candidate)
          return []
        }

        return [candidate]
      }

      const keys: string[] = []
      const seen = new Set<string>()
      for (const candidate of resolved) {
        if (typeof candidate !== "string") {
          this.emitError("[ActionMap] Invalid event match resolver candidate:", candidate)
          continue
        }

        if (!candidate || seen.has(candidate)) {
          continue
        }

        seen.add(candidate)
        keys.push(candidate)
      }

      return keys
    }

    const keys: string[] = []
    const seen = new Set<string>()

    for (const resolver of resolvers) {
      let resolved: readonly string[] | undefined

      try {
        resolved = resolver(event)
      } catch (error) {
        this.emitError("[ActionMap] Error in event match resolver:", error)
        continue
      }

      if (!resolved || resolved.length === 0) {
        continue
      }

      for (const candidate of resolved) {
        if (typeof candidate !== "string") {
          this.emitError("[ActionMap] Invalid event match resolver candidate:", candidate)
          continue
        }

        if (!candidate || seen.has(candidate)) {
          continue
        }

        seen.add(candidate)
        keys.push(candidate)
      }
    }

    return keys
  }

  private runReleaseBindings(
    layer: RegisteredLayer,
    strokeKey: string,
    event: KeyEvent,
    focused: Renderable | null,
  ): { handled: boolean; stop: boolean } {
    let handled = false

    for (const binding of layer.compiledBindings) {
      if (binding.event !== "release") {
        continue
      }

      const firstPart = binding.sequence[0]
      if (!firstPart || firstPart.matchKey !== strokeKey) {
        continue
      }

      if (!this.matchesConditions(binding)) {
        continue
      }

      const bindingHandled = this.runBinding(layer, binding, event, focused)
      if (!bindingHandled) {
        continue
      }

      handled = true
      if (!binding.fallthrough) {
        return { handled: true, stop: true }
      }
    }

    return { handled, stop: false }
  }

  private getReachableChild(node: SequenceNode, matchKeys: readonly string[]): SequenceNode | undefined {
    for (const strokeKey of matchKeys) {
      const child = node.children.get(strokeKey)
      if (!child || !this.nodeHasReachableBindings(child)) {
        continue
      }

      return child
    }

    return undefined
  }

  private nodeHasReachableBindings(node: SequenceNode): boolean {
    return this.hasMatchingBindings(node.reachableBindings)
  }

  private collectSequencePartsFromNode(node: SequenceNode): ParsedKeyPart[] {
    const nodes: SequenceNode[] = []
    let current: SequenceNode | null = node

    while (current && current.stroke) {
      nodes.push(current)
      current = current.parent
    }

    nodes.reverse()

    return nodes.map((candidate) => {
      return createParsedKeyPart(candidate.stroke!, this.getNodeDisplay(candidate), candidate.matchKey!)
    })
  }

  private collectSequenceStrokesFromNode(node: SequenceNode): ParsedKeyStroke[] {
    return this.collectSequencePartsFromNode(node).map((part) => cloneStroke(part.stroke))
  }

  private getMatchingBindings(bindings: readonly CompiledBinding[]): CompiledBinding[] {
    const matches: CompiledBinding[] = []

    for (const binding of bindings) {
      if (this.matchesConditions(binding) && this.isVisibleBinding(binding)) {
        matches.push(binding)
      }
    }

    return matches
  }

  private hasMatchingBindings(bindings: readonly CompiledBinding[]): boolean {
    for (const binding of bindings) {
      if (this.matchesConditions(binding) && this.isVisibleBinding(binding)) {
        return true
      }
    }

    return false
  }

  private isVisibleBinding(binding: CompiledBinding): boolean {
    return binding.command === undefined || binding.run !== undefined
  }

  private getNodeDisplay(
    node: SequenceNode,
    reachableBindings: readonly CompiledBinding[] = this.getMatchingBindings(node.reachableBindings),
  ): string {
    if (!node.stroke) {
      return ""
    }

    const partIndex = node.depth - 1
    let display: string | undefined

    for (const binding of reachableBindings) {
      const part = binding.sequence[partIndex]
      if (!part) {
        continue
      }

      if (display === undefined) {
        display = part.display
        continue
      }

      if (display !== part.display) {
        return stringifyKeyStroke(node.stroke)
      }
    }

    return display ?? stringifyKeyStroke(node.stroke)
  }

  private toActiveBinding(binding: CompiledBinding): ActionMapActiveBinding {
    if (binding.activeBindingCacheVersion === this.commandMetadataVersion) {
      const cached = binding.activeBindingCache
      if (cached) {
        return cached
      }
    }

    const activeBinding: ActionMapActiveBinding = {
      sequence: binding.sequence,
      command: binding.command,
      commandAttrs: binding.commandAttrs,
      attrs: binding.attrs,
      event: binding.event,
      preventDefault: binding.preventDefault,
      fallthrough: binding.fallthrough,
    }

    binding.activeBindingCacheVersion = this.commandMetadataVersion
    binding.activeBindingCache = activeBinding
    return activeBinding
  }

  private collectActiveBindings(bindings: readonly CompiledBinding[]): ActionMapActiveBinding[] {
    return bindings.map((binding) => this.toActiveBinding(binding))
  }

  private getActiveCommandAttrs(binding: CompiledBinding): Readonly<ActionMapAttributes> | undefined {
    return binding.commandAttrs
  }

  private collectActiveKeysAtRoot(
    activeLayers: RegisteredLayer[],
    includeBindings: boolean,
    includeMetadata: boolean,
  ): readonly ActionMapActiveKey[] {
    const activeKeys = new Map<string, ActiveKeyState>()
    const stopped = new Set<string>()
    const hasLayerConditions = this.layersWithConditions > 0

    for (const layer of activeLayers) {
      if (hasLayerConditions && !this.hasNoConditions(layer) && !this.matchesConditions(layer)) {
        continue
      }

      for (const [bindingKey, child] of layer.root.children) {
        if (stopped.has(bindingKey)) {
          continue
        }

        const selection = this.selectActiveKey(child, includeBindings)
        if (!selection) {
          continue
        }

        const existing = activeKeys.get(bindingKey)
        if (!existing) {
          activeKeys.set(bindingKey, this.createActiveKeyState(child.stroke!, selection, includeBindings))
        } else {
          this.updateActiveKeyState(existing, selection, includeBindings)
        }

        if (selection.stop) {
          stopped.add(bindingKey)
        }
      }
    }

    const materialized: ActionMapActiveKey[] = []
    for (const state of activeKeys.values()) {
      const activeKey = this.materializeActiveKey(state, includeBindings, includeMetadata)
      if (!activeKey) {
        continue
      }

      materialized.push(activeKey)
    }

    return materialized
  }

  private collectActiveKeysFromChildren(
    children: ReadonlyMap<string, SequenceNode>,
    includeBindings: boolean,
    includeMetadata: boolean,
  ): readonly ActionMapActiveKey[] {
    const activeKeys: ActionMapActiveKey[] = []

    for (const child of children.values()) {
      const selection = this.selectActiveKey(child, includeBindings)
      if (!selection) {
        continue
      }

      const activeKey = this.materializeActiveKey(
        this.createActiveKeyState(child.stroke!, selection, includeBindings),
        includeBindings,
        includeMetadata,
      )
      if (!activeKey) {
        continue
      }

      activeKeys.push(activeKey)
    }

    return activeKeys
  }

  private selectActiveKey(node: SequenceNode, includeBindings: boolean): ActiveKeySelection | undefined {
    if (node.children.size > 0) {
      return this.selectPrefixActiveKey(node, includeBindings)
    }

    return this.selectExactActiveKey(node, includeBindings)
  }

  private selectPrefixActiveKey(node: SequenceNode, includeBindings: boolean): ActiveKeySelection | undefined {
    if (!node.stroke) {
      return undefined
    }

    const reachableBindings = this.getMatchingBindings(node.reachableBindings)
    if (reachableBindings.length === 0) {
      return undefined
    }

    const prefixBindings = this.getMatchingBindings(node.bindings)

    return {
      display: this.getNodeDisplay(node, reachableBindings),
      continues: true,
      firstBinding: prefixBindings[0],
      bindings: includeBindings && prefixBindings.length > 0 ? prefixBindings : undefined,
      stop: true,
    }
  }

  private selectExactActiveKey(node: SequenceNode, includeBindings: boolean): ActiveKeySelection | undefined {
    if (!node.stroke) {
      return undefined
    }

    const selected = this.selectActiveBindings(node.bindings)
    if (!selected) {
      return undefined
    }

    const display =
      selected.bindings.length === 1
        ? (selected.bindings[0]?.sequence[node.depth - 1]?.display ?? stringifyKeyStroke(node.stroke))
        : this.getNodeDisplay(node, selected.bindings)

    return {
      display,
      continues: false,
      firstBinding: selected.bindings[0],
      commandBinding: selected.commandBinding,
      bindings: includeBindings ? [...selected.bindings] : undefined,
      stop: selected.stop,
    }
  }

  private selectActiveBindings(
    bindings: readonly CompiledBinding[],
  ): { bindings: readonly CompiledBinding[]; commandBinding?: CompiledBinding; stop: boolean } | undefined {
    const selected: CompiledBinding[] = []
    let commandBinding: CompiledBinding | undefined

    for (const binding of bindings) {
      if (!this.matchesConditions(binding) || !this.isVisibleBinding(binding)) {
        continue
      }

      selected.push(binding)
      if (!binding.run) {
        continue
      }

      commandBinding ??= binding
      if (!binding.fallthrough) {
        return { bindings: selected, commandBinding, stop: true }
      }
    }

    if (selected.length === 0) {
      return undefined
    }

    return { bindings: selected, commandBinding, stop: false }
  }

  private createActiveKeyState(
    stroke: ParsedKeyStroke,
    selection: ActiveKeySelection,
    includeBindings: boolean,
  ): ActiveKeyState {
    return {
      stroke,
      display: selection.display,
      continues: selection.continues,
      firstBinding: selection.firstBinding,
      commandBinding: selection.commandBinding,
      bindings: includeBindings && selection.bindings ? [...selection.bindings] : undefined,
    }
  }

  private updateActiveKeyState(state: ActiveKeyState, selection: ActiveKeySelection, includeBindings: boolean): void {
    if (!state.firstBinding && selection.firstBinding) {
      state.firstBinding = selection.firstBinding
    }

    if (!state.commandBinding && selection.commandBinding) {
      state.commandBinding = selection.commandBinding
    }

    if (selection.continues) {
      state.continues = true
    }

    if (!includeBindings || !selection.bindings || selection.bindings.length === 0) {
      return
    }

    if (!state.bindings) {
      state.bindings = [...selection.bindings]
      return
    }

    state.bindings.push(...selection.bindings)
  }

  private materializeActiveKey(
    state: ActiveKeyState,
    includeBindings: boolean,
    includeMetadata: boolean,
  ): ActionMapActiveKey | undefined {
    if (!state.commandBinding && !state.continues) {
      return undefined
    }

    const activeKey: ActionMapActiveKey = {
      stroke: cloneStroke(state.stroke),
      display: state.display,
      continues: state.continues,
    }

    if (state.commandBinding) {
      activeKey.command = state.commandBinding.command
    }

    if (includeBindings && state.bindings && state.bindings.length > 0) {
      activeKey.bindings =
        state.bindings.length === 1
          ? [this.toActiveBinding(state.bindings[0]!)]
          : this.collectActiveBindings(state.bindings)
    }

    if (includeMetadata) {
      const metadataBinding = state.firstBinding
      if (metadataBinding?.attrs) {
        activeKey.bindingAttrs = metadataBinding.attrs
      }

      const commandAttrs = state.commandBinding ? this.getActiveCommandAttrs(state.commandBinding) : undefined
      if (commandAttrs) {
        activeKey.commandAttrs = commandAttrs
      }
    }

    return activeKey
  }

  private runBindings(
    layer: RegisteredLayer,
    bindings: CompiledBinding[],
    event: KeyEvent,
    focused: Renderable | null,
  ): { handled: boolean; stop: boolean } {
    let handled = false

    for (const binding of bindings) {
      if (!this.matchesConditions(binding)) {
        continue
      }

      const bindingHandled = this.runBinding(layer, binding, event, focused)
      if (!bindingHandled) {
        continue
      }

      handled = true
      if (!binding.fallthrough) {
        return { handled: true, stop: true }
      }
    }

    return { handled, stop: false }
  }

  private runBinding(
    layer: RegisteredLayer,
    binding: CompiledBinding,
    event: KeyEvent,
    focused: Renderable | null,
  ): boolean {
    const run = binding.run
    if (!run) {
      return false
    }

    const context: ActionMapCommandContext = {
      actionMap: this,
      event,
      focused,
      target: layer.target ?? null,
      data: this.getReadonlyData(),
    }

    let result: ActionMapCommandResult
    try {
      result = run(context)
    } catch (error) {
      this.emitError(`[ActionMap] Error running command ${this.describeBindingCommand(binding)}:`, error)
      this.applyBindingEventEffects(binding, event)
      return true
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        this.emitError(`[ActionMap] Async error in command ${this.describeBindingCommand(binding)}:`, error)
      })
      this.applyBindingEventEffects(binding, event)
      return true
    }

    if (result === false) {
      return false
    }

    this.applyBindingEventEffects(binding, event)
    return true
  }

  private describeBindingCommand(binding: CompiledBinding): string {
    if (typeof binding.command === "string") {
      return `"${binding.command}"`
    }

    if (typeof binding.command === "function") {
      return "<function>"
    }

    return "<none>"
  }

  private applyBindingEventEffects(binding: CompiledBinding, event: KeyEvent): void {
    if (!binding.preventDefault) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
  }

  private matchRequirements(requires: readonly [name: string, value: unknown][]): boolean {
    if (requires.length === 0) {
      return true
    }

    for (const [name, value] of requires) {
      if (!Object.is(this.data[name], value)) {
        return false
      }
    }

    return true
  }

  private hasNoConditions(target: RuntimeMatchable): boolean {
    return target.requires.length === 0 && target.matchers.length === 0
  }

  private registerRuntimeMatchable(target: RuntimeMatchable): void {
    // Reactive matchers invalidate only their own target. If subscription
    // setup fails, keep the matcher registered but lose automatic invalidation.
    for (const matcher of target.matchers) {
      if (!matcher.subscribe) {
        continue
      }

      try {
        matcher.dispose = matcher.subscribe(() => {
          target.matchCacheDirty = true
          this.queueStateChange()
        })
      } catch (error) {
        this.emitError(
          getErrorMessage(error, `Failed to subscribe to reactive matcher from ${matcher.source}`),
          error,
        )
      }
    }

    if (target.conditionKeys.length > 0) {
      for (const key of target.conditionKeys) {
        const dependents = this.runtimeKeyDependents.get(key)
        if (dependents) {
          dependents.add(target)
          continue
        }

        this.runtimeKeyDependents.set(key, new Set([target]))
      }
    }

    if (!target.hasUnkeyedMatchers) {
      target.matchCacheDirty = true
    }
  }

  private unregisterRuntimeMatchable(target: RuntimeMatchable): void {
    for (const matcher of target.matchers) {
      if (!matcher.dispose) {
        continue
      }

      try {
        matcher.dispose()
      } catch (error) {
        this.emitError(
          getErrorMessage(error, `Failed to dispose reactive matcher from ${matcher.source}`),
          error,
        )
      }

      matcher.dispose = undefined
    }

    if (target.conditionKeys.length === 0) {
      return
    }

    for (const key of target.conditionKeys) {
      const dependents = this.runtimeKeyDependents.get(key)
      if (!dependents) {
        continue
      }

      dependents.delete(target)
      if (dependents.size === 0) {
        this.runtimeKeyDependents.delete(key)
      }
    }
  }

  private invalidateRuntimeConditionKey(name: string): void {
    const dependents = this.runtimeKeyDependents.get(name)
    if (!dependents) {
      return
    }

    for (const target of dependents) {
      target.matchCacheDirty = true
    }
  }

  private hasFreshConditionCache(target: RuntimeMatchable): boolean {
    // Raw callbacks are never cacheable because nothing can invalidate them.
    if (target.hasUnkeyedMatchers) {
      return false
    }

    return target.matchCacheDirty !== true && target.matchCache !== undefined
  }

  private updateConditionCache(target: RuntimeMatchable, matched: boolean): void {
    if (target.hasUnkeyedMatchers) {
      return
    }

    target.matchCacheDirty = false
    target.matchCache = matched
  }

  private matchesRuntimeMatcher(matcher: RuntimeMatcher): boolean {
    try {
      return matcher.match()
    } catch (error) {
      this.emitError(`[ActionMap] Error evaluating runtime matcher from ${matcher.source}:`, error)
      return false
    }
  }

  private matchesRuntimeMatchers(target: RuntimeMatchable): boolean {
    if (target.matchers.length === 0) {
      return true
    }

    if (target.matchers.length === 1) {
      const [matcher] = target.matchers
      return matcher ? this.matchesRuntimeMatcher(matcher) : true
    }

    for (const matcher of target.matchers) {
      if (!this.matchesRuntimeMatcher(matcher)) {
        return false
      }
    }

    return true
  }

  private matchesConditions(target: RuntimeMatchable): boolean {
    if (this.hasNoConditions(target)) {
      return true
    }

    if (this.hasFreshConditionCache(target)) {
      return target.matchCache === true
    }

    const matched = this.matchRequirements(target.requires) && this.matchesRuntimeMatchers(target)
    this.updateConditionCache(target, matched)
    return matched
  }

  private layerMatchesRuntimeState(layer: RegisteredLayer): boolean {
    if (this.layersWithConditions === 0 || this.hasNoConditions(layer)) {
      return true
    }

    return this.matchesConditions(layer)
  }

  private setPendingSequence(next: PendingSequenceState | null): void {
    if (this.isSamePendingSequence(this.pendingSequence, next)) {
      return
    }

    this.pendingSequence = next
    this.invalidateDerivedStateCaches()
    this.notifyPendingSequenceChange()
    this.queueStateChange()
  }

  private invalidateDerivedStateCaches(): void {
    this.pendingSequenceCacheVersion = -1
    this.pendingSequencePartsCacheVersion = -1
    this.activeKeysPlainCacheVersion = -1
    this.activeKeysBindingsCacheVersion = -1
    this.activeKeysMetadataCacheVersion = -1
    this.activeKeysBindingsAndMetadataCacheVersion = -1
  }

  private isSamePendingSequence(current: PendingSequenceState | null, next: PendingSequenceState | null): boolean {
    if (current === next) {
      return true
    }

    if (!current || !next) {
      return false
    }

    return current.layer === next.layer && current.node === next.node
  }

  private notifyPendingSequenceChange(): void {
    if (!this.hooks.has("pendingSequence")) {
      return
    }

    const sequence = this.pendingSequence ? this.collectSequenceStrokesFromNode(this.pendingSequence.node) : []
    this.hooks.emit("pendingSequence", sequence)
  }

  private getFocusedRenderable(): Renderable | null {
    const focused = this.renderer.currentFocusedRenderable
    if (!focused) {
      return null
    }

    if (focused.isDestroyed) {
      return null
    }

    if (!focused.focused) {
      return null
    }

    return focused
  }

  private layerCanCacheActiveKeys(layer: RegisteredLayer): boolean {
    return !layer.hasUnkeyedMatchers && !layer.hasUnkeyedBindings
  }

  private activeLayersCanCacheActiveKeys(activeLayers: readonly RegisteredLayer[]): boolean {
    for (const layer of activeLayers) {
      if (!this.layerCanCacheActiveKeys(layer)) {
        return false
      }
    }

    return true
  }

  private getActiveLayers(focused: Renderable | null): RegisteredLayer[] {
    const activeLayers: RegisteredLayer[] = []

    if (focused) {
      let current: Renderable | null = focused
      let isFocusedTarget = true

      while (current) {
        const bucket = this.targetLayers.get(current)
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

    activeLayers.push(...this.globalLayers)

    return activeLayers
  }

  private isLayerActiveForFocused(layer: RegisteredLayer, focused: Renderable | null): boolean {
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

  private getReadonlyData(): Readonly<ActionMapEventData> {
    if (this.readonlyDataVersion === this.dataVersion) {
      return this.readonlyData
    }

    this.readonlyData = Object.freeze({ ...this.data })
    this.readonlyDataVersion = this.dataVersion
    return this.readonlyData
  }

  private handleUnresolvedCommand(command: string, binding: CompiledBinding): void {
    const sequence = stringifyKeySequence(binding.sourceBinding.sequence, { preferDisplay: true })
    const warningKey = `unresolved:${binding.sourceLayerOrder}:${binding.sourceBindingIndex}:${command}:${sequence}`

    this.warnOnce(
      warningKey,
      `[ActionMap] Unresolved command "${command}" for binding "${sequence}" in ${binding.sourceScope} layer`,
    )

    if (!this.hooks.has("unresolvedCommand")) {
      return
    }

    const context: ActionMapUnresolvedCommandContext = {
      command,
      binding: cloneParsedBindingInput(binding.sourceBinding),
      scope: binding.sourceScope,
      target: binding.sourceTarget,
    }

    this.hooks.emit("unresolvedCommand", context)
  }

  private warnOnce(key: string, message: string): void {
    if (this.usedWarningKeys.has(key)) {
      return
    }

    this.usedWarningKeys.add(key)
    this.emitWarning(message)
  }

  private warnUnknownField(kind: "binding" | "layer", fieldName: string): void {
    this.warnOnce(`${kind}:${fieldName}`, `[ActionMap] Unknown ${kind} field "${fieldName}" was ignored`)
  }

  private warnUnknownToken(token: string, sequence: string): void {
    this.warnOnce(`token:${token}`, `[ActionMap] Unknown token "${token}" in key sequence "${sequence}" was ignored`)
  }

  private ensureValidPendingSequence(): PendingSequenceState | undefined {
    if (!this.pendingSequence) {
      return undefined
    }

    const focused = this.getFocusedRenderable()

    if (
      !this.layers.has(this.pendingSequence.layer) ||
      !this.isLayerActiveForFocused(this.pendingSequence.layer, focused)
    ) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.layerMatchesRuntimeState(this.pendingSequence.layer)) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.nodeHasReachableBindings(this.pendingSequence.node)) {
      this.setPendingSequence(null)
      return undefined
    }

    return this.pendingSequence
  }
}

export function getActionMap(renderer: CliRenderer): ActionMap {
  const existing = actionMapsByRenderer.get(renderer)
  if (existing) {
    if (existing.isDestroyed) {
      actionMapsByRenderer.delete(renderer)
    } else {
      return existing
    }
  }

  const manager = new ActionMap(renderer)
  actionMapsByRenderer.set(renderer, manager)

  renderer.once("destroy", () => {
    manager.destroy()
    actionMapsByRenderer.delete(renderer)
  })

  return manager
}
