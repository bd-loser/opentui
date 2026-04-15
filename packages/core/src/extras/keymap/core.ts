import { RenderableEvents, type Renderable } from "../../Renderable.js"
import { CliRenderEvents, type CliRenderer } from "../../renderer.js"
import type { KeyEvent } from "../../lib/KeyHandler.js"
import type {
  ActiveKeySelection,
  ActiveKeyState,
  CompiledBinding,
  CompiledBindingsResult,
  KeymapActiveBinding,
  KeymapActiveKey,
  KeymapActiveKeyOptions,
  KeymapAttributes,
  KeymapBindingCompiler,
  KeymapBindingExpander,
  KeymapBindingExpanderContext,
  KeymapBindingParser,
  KeymapBindingSyntax,
  KeymapBindingCommand,
  KeymapBindingEvent,
  KeymapBindingFieldCompiler,
  KeymapBindingInput,
  KeymapBindingParserContext,
  KeymapHookListener,
  KeymapHookName,
  KeymapHooks,
  KeymapParsedBindingInput,
  KeymapCommand,
  KeymapCommandContext,
  KeymapCommandFieldCompiler,
  KeymapCommandHandler,
  KeymapCommandInfo,
  KeymapCommandResolver,
  KeymapCommandResolverContext,
  KeymapCommandResult,
  KeymapEventData,
  KeymapKeyInputContext,
  KeyLike,
  KeymapLayer,
  KeymapLayerFieldCompiler,
  KeymapLogger,
  KeymapManager,
  KeymapManagerOptions,
  KeymapRawInputContext,
  KeymapResolvedBindingCommand,
  KeymapScope,
  KeymapEventMatchResolver,
  KeyStroke,
  KeymapToken,
  KeymapUnresolvedCommandContext,
  ParsedKeyPart,
  ParsedKeyToken,
  ParsedKeyStroke,
  PendingSequenceState,
  RegisteredCommand,
  RegisteredKeyHook,
  RegisteredLayer,
  RegisteredLayerBucket,
  RegisteredRawHook,
  ResolvedKeymapLogger,
  RuntimeMatchable,
  RuntimeMatcher,
  SequenceNode,
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
import { defaultBindingParser, defaultBindingSyntax, defaultEventMatchResolver } from "./default-parser.js"
import { Emitter } from "./emitter.js"

const keymapManagersByRenderer = new WeakMap<CliRenderer, KeymapManagerImpl>()

const NOOP_KEYMAP_LOGGER: ResolvedKeymapLogger = {
  warn() {},
  error() {},
}

export const RESERVED_BINDING_FIELDS = new Set(["key", "cmd", "event", "consume", "fallthrough"])

const RESERVED_LAYER_FIELDS = new Set(["target", "scope", "priority", "bindings"])

const RESERVED_COMMAND_FIELDS = new Set(["name", "run"])
const EMPTY_COMPILE_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})

function cloneCompileFieldValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value]
  }

  if (value && typeof value === "object") {
    return { ...(value as Record<string, unknown>) }
  }

  return value
}

function cloneParsedBindingInput(binding: KeymapParsedBindingInput): KeymapParsedBindingInput {
  return {
    ...binding,
    sequence: binding.sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)),
  }
}

function expandBindingInputWithExpanders(
  key: KeyLike,
  expanders: readonly KeymapBindingExpander[],
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
      const result = expander({ input, layer } satisfies KeymapBindingExpanderContext)
      if (!result) {
        nextCandidates.push(input)
        continue
      }

      if (result.length === 0) {
        throw new Error(`Keymap binding expander must return at least one key sequence for "${input}"`)
      }

      for (const expandedInput of result) {
        if (typeof expandedInput !== "string") {
          throw new Error(`Keymap binding expander must return string key sequences for "${input}"`)
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
  parsers: readonly KeymapBindingParser[],
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
    throw new Error("No keymap binding parsers are registered")
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
      const result = parser({ input: key, index, layer, tokens } satisfies KeymapBindingParserContext)
      if (!result) {
        continue
      }

      if (result.nextIndex <= index || result.nextIndex > key.length) {
        throw new Error(`Keymap binding parser must advance the input for "${key}" at index ${index}`)
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
      throw new Error(`No keymap binding parser handled input at index ${index} in "${key}"`)
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
  parsers: readonly KeymapBindingParser[],
  options?: {
    tokens?: ReadonlyMap<string, ParsedKeyToken>
    layer?: Readonly<Record<string, unknown>>
    parseObjectKey?: (key: KeyStroke) => ParsedKeyPart
  },
): ParsedKeyPart {
  if (typeof key !== "string") {
    const parseObjectKey = options?.parseObjectKey
    if (!parseObjectKey) {
      throw new Error("No keymap binding syntax is registered")
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

function resolveKeymapLogger(logger?: KeymapLogger): ResolvedKeymapLogger {
  if (!logger) {
    return NOOP_KEYMAP_LOGGER
  }

  return {
    warn: logger.warn ?? NOOP_KEYMAP_LOGGER.warn,
    error: logger.error ?? logger.warn ?? NOOP_KEYMAP_LOGGER.error,
  }
}

class KeymapManagerImpl implements KeymapManager {
  public readonly renderer: CliRenderer
  private logger: ResolvedKeymapLogger

  private layers = new Set<RegisteredLayer>()
  private globalLayers: RegisteredLayer[] = []
  private targetLayers = new WeakMap<Renderable, RegisteredLayerBucket>()
  private tokens = new Map<string, ParsedKeyToken>()
  private bindingSyntax: KeymapBindingSyntax | undefined
  private layerFields = new Map<string, KeymapLayerFieldCompiler>()
  private bindingExpanders: KeymapBindingExpander[] = []
  private bindingParsers: KeymapBindingParser[] = []
  private bindingCompilers: KeymapBindingCompiler[] = []
  private bindingFields = new Map<string, KeymapBindingFieldCompiler>()
  private commandFields = new Map<string, KeymapCommandFieldCompiler>()
  private runtimeKeyDependents = new Map<string, Set<RuntimeMatchable>>()
  private commandResolvers: KeymapCommandResolver[] = []
  private eventMatchResolvers: KeymapEventMatchResolver[] = []
  private keyHooks: RegisteredKeyHook[] = []
  private rawHooks: RegisteredRawHook[] = []
  private hooks: Emitter<KeymapHooks>
  private commands = new Map<string, RegisteredCommand>()
  private commandMetadataVersion = 0
  private layersWithConditions = 0
  private data: KeymapEventData = {}
  private dataVersion = 0
  private readonlyDataVersion = -1
  private readonlyData: Readonly<KeymapEventData> = Object.freeze({})
  private pendingSequence: PendingSequenceState | null = null
  private order = 0
  private destroyed = false
  private derivedStateVersion = 0
  private pendingSequenceCacheVersion = -1
  private pendingSequenceCache: readonly ParsedKeyStroke[] = []
  private pendingSequencePartsCacheVersion = -1
  private pendingSequencePartsCache: readonly ParsedKeyPart[] = []
  private activeKeysPlainCacheVersion = -1
  private activeKeysPlainCache: readonly KeymapActiveKey[] = []
  private activeKeysBindingsCacheVersion = -1
  private activeKeysBindingsCache: readonly KeymapActiveKey[] = []
  private activeKeysMetadataCacheVersion = -1
  private activeKeysMetadataCache: readonly KeymapActiveKey[] = []
  private activeKeysBindingsAndMetadataCacheVersion = -1
  private activeKeysBindingsAndMetadataCache: readonly KeymapActiveKey[] = []
  private stateChangeDepth = 0
  private stateChangePending = false
  private flushingStateChange = false
  private usedWarningKeys = new Set<string>()

  private readonly keypressListener: (event: KeyEvent) => void
  private readonly keyreleaseListener: (event: KeyEvent) => void
  private readonly rawListener: (sequence: string) => boolean
  private readonly focusedRenderableListener: (focused: Renderable | null) => void

  constructor(renderer: CliRenderer, options?: KeymapManagerOptions) {
    this.renderer = renderer
    this.logger = resolveKeymapLogger(options?.logger)
    this.hooks = new Emitter<KeymapHooks>((name, error) => {
      this.reportHookError(name, error)
    })
    this.bindingSyntax = defaultBindingSyntax
    this.bindingParsers = [defaultBindingParser]
    this.eventMatchResolvers = [defaultEventMatchResolver]
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

  public applyOptions(options?: KeymapManagerOptions): void {
    if (!options || options.logger === undefined) {
      return
    }

    this.logger = resolveKeymapLogger(options.logger)
  }

  public destroy(): void {
    if (this.destroyed) {
      return
    }

    this.setPendingSequence(null)

    for (const layer of this.layers) {
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
    this.bindingExpanders = []
    this.bindingParsers = []
    this.bindingCompilers = []
    this.bindingFields.clear()
    this.commandFields.clear()
    this.runtimeKeyDependents.clear()
    this.commandResolvers = []
    this.eventMatchResolvers = []
    this.keyHooks = []
    this.rawHooks = []
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
    this.logger = NOOP_KEYMAP_LOGGER

    this.renderer.keyInput.off("keypress", this.keypressListener)
    this.renderer.keyInput.off("keyrelease", this.keyreleaseListener)
    this.renderer.removeInputHandler(this.rawListener)
    this.renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, this.focusedRenderableListener)
  }

  public setData(name: string, value: unknown): void {
    this.assertNotDestroyed()

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
    this.assertNotDestroyed()
    return this.data[name]
  }

  public invalidateRuntimeKey(name: string): void {
    this.assertNotDestroyed()
    this.runWithStateChangeBatch(() => {
      this.invalidateRuntimeConditionKey(name)
      this.ensureValidPendingSequence()
      this.queueStateChange()
    })
  }

  public hasPendingSequence(): boolean {
    this.assertNotDestroyed()
    return this.ensureValidPendingSequence() !== undefined
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    this.assertNotDestroyed()

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
    this.assertNotDestroyed()

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
    this.assertNotDestroyed()
    this.setPendingSequence(null)
  }

  public popPendingSequence(): boolean {
    this.assertNotDestroyed()

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

  public getActiveKeys(options?: KeymapActiveKeyOptions): readonly KeymapActiveKey[] {
    this.assertNotDestroyed()

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

    let activeKeys: readonly KeymapActiveKey[]

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

  public hook<TName extends KeymapHookName>(name: TName, fn: KeymapHookListener<KeymapHooks[TName]>): () => void {
    this.assertNotDestroyed()

    return this.hooks.hook(name, fn)
  }

  public registerLayer(layer: KeymapLayer): () => void {
    this.assertNotDestroyed()

    return this.runWithStateChangeBatch(() => {
      const scope = this.normalizeScope(layer)
      const bindingInputs = snapshotBindingInputs(layer.bindings)
      const order = this.order++
      const { requires, matchers, conditionKeys, hasUnkeyedMatchers, compileFields } = this.compileLayerRuntimeState(layer)
      const compiledBindings = this.compileBindings(bindingInputs, this.tokens, scope, layer.target, order, compileFields)
      const target = layer.target
      if (target && target.isDestroyed) {
        throw new Error("Cannot register a keymap layer for a destroyed renderable")
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

  public registerLayerFields(fields: Record<string, KeymapLayerFieldCompiler>): () => void {
    this.assertNotDestroyed()

    const entries = Object.entries(fields)
    for (const [name] of entries) {
      if (RESERVED_LAYER_FIELDS.has(name)) {
        throw new Error(`Keymap layer field "${name}" is reserved`)
      }

      if (this.layerFields.has(name)) {
        throw new Error(`Keymap layer field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      this.layerFields.set(name, compiler)
    }

    return () => {
      for (const [name, compiler] of entries) {
        const current = this.layerFields.get(name)
        if (current === compiler) {
          this.layerFields.delete(name)
        }
      }
    }
  }

  public registerBindingCompiler(compiler: KeymapBindingCompiler): () => void {
    this.assertNotDestroyed()

    this.bindingCompilers = [...this.bindingCompilers, compiler]

    return () => {
      this.bindingCompilers = this.bindingCompilers.filter((candidate) => candidate !== compiler)
    }
  }

  public prependBindingParser(parser: KeymapBindingParser): () => void {
    this.assertNotDestroyed()

    this.bindingParsers = [parser, ...this.bindingParsers]

    return () => {
      this.bindingParsers = this.bindingParsers.filter((candidate) => candidate !== parser)
    }
  }

  public appendBindingParser(parser: KeymapBindingParser): () => void {
    this.assertNotDestroyed()

    this.bindingParsers = [...this.bindingParsers, parser]

    return () => {
      this.bindingParsers = this.bindingParsers.filter((candidate) => candidate !== parser)
    }
  }

  public clearBindingParsers(): void {
    this.assertNotDestroyed()
    this.bindingParsers = []
  }

  public setBindingSyntax(syntax: KeymapBindingSyntax): void {
    this.assertNotDestroyed()
    this.bindingSyntax = syntax
  }

  public clearBindingSyntax(): void {
    this.assertNotDestroyed()
    this.bindingSyntax = undefined
  }

  public registerToken(token: KeymapToken): () => void {
    this.assertNotDestroyed()

    const normalizedToken = this.normalizeTokenName(token.token)

    if (this.tokens.has(normalizedToken)) {
      throw new Error(`Keymap token "${normalizedToken}" is already registered`)
    }

    const parsedToken = parseSingleKeyPartWithParsers(token.key, this.bindingParsers, {
      tokens: this.tokens,
      layer: EMPTY_COMPILE_FIELDS,
      parseObjectKey: (key) => this.parseObjectKeyPart(key),
    })
    const registeredToken: ParsedKeyToken = {
      stroke: parsedToken.stroke,
      matchKey: parsedToken.matchKey,
    }

    const nextTokens = new Map(this.tokens)
    nextTokens.set(normalizedToken, registeredToken)
    this.applyTokenState(nextTokens)

    return () => {
      const current = this.tokens.get(normalizedToken)
      if (current === registeredToken) {
        const nextTokens = new Map(this.tokens)
        nextTokens.delete(normalizedToken)
        this.applyTokenState(nextTokens)
      }
    }
  }

  public prependBindingExpander(expander: KeymapBindingExpander): () => void {
    this.assertNotDestroyed()

    this.bindingExpanders = [expander, ...this.bindingExpanders]

    return () => {
      this.bindingExpanders = this.bindingExpanders.filter((candidate) => candidate !== expander)
    }
  }

  public appendBindingExpander(expander: KeymapBindingExpander): () => void {
    this.assertNotDestroyed()

    this.bindingExpanders = [...this.bindingExpanders, expander]

    return () => {
      this.bindingExpanders = this.bindingExpanders.filter((candidate) => candidate !== expander)
    }
  }

  public clearBindingExpanders(): void {
    this.assertNotDestroyed()
    this.bindingExpanders = []
  }

  public registerBindingFields(fields: Record<string, KeymapBindingFieldCompiler>): () => void {
    this.assertNotDestroyed()

    const entries = Object.entries(fields)
    for (const [name] of entries) {
      if (RESERVED_BINDING_FIELDS.has(name)) {
        throw new Error(`Keymap binding field "${name}" is reserved`)
      }

      if (this.bindingFields.has(name)) {
        throw new Error(`Keymap binding field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      this.bindingFields.set(name, compiler)
    }

    return () => {
      for (const [name, compiler] of entries) {
        const current = this.bindingFields.get(name)
        if (current === compiler) {
          this.bindingFields.delete(name)
        }
      }
    }
  }

  public registerCommandFields(fields: Record<string, KeymapCommandFieldCompiler>): () => void {
    this.assertNotDestroyed()

    const entries = Object.entries(fields)
    for (const [name] of entries) {
      if (RESERVED_COMMAND_FIELDS.has(name)) {
        throw new Error(`Keymap command field "${name}" is reserved`)
      }

      if (this.commandFields.has(name)) {
        throw new Error(`Keymap command field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      this.commandFields.set(name, compiler)
    }

    return () => {
      for (const [name, compiler] of entries) {
        const current = this.commandFields.get(name)
        if (current === compiler) {
          this.commandFields.delete(name)
        }
      }
    }
  }

  public registerCommandResolver(resolver: KeymapCommandResolver): () => void {
    this.assertNotDestroyed()

    return this.runWithStateChangeBatch(() => {
      this.commandResolvers = [...this.commandResolvers, resolver]
      this.refreshBindingCommandResolution()
      this.queueStateChange()

      return () => {
        this.runWithStateChangeBatch(() => {
          const nextResolvers = this.commandResolvers.filter((candidate) => candidate !== resolver)
          if (nextResolvers.length === this.commandResolvers.length) {
            return
          }

          this.commandResolvers = nextResolvers
          this.refreshBindingCommandResolution()
          this.queueStateChange()
        })
      }
    })
  }

  public registerEventMatchResolver(resolver: KeymapEventMatchResolver): () => void {
    this.assertNotDestroyed()

    this.eventMatchResolvers = [...this.eventMatchResolvers, resolver]

    return () => {
      this.eventMatchResolvers = this.eventMatchResolvers.filter((candidate) => candidate !== resolver)
    }
  }

  public clearEventMatchResolvers(): void {
    this.assertNotDestroyed()
    this.eventMatchResolvers = []
  }

  public onKeyInput(
    fn: (ctx: KeymapKeyInputContext) => void,
    options?: { priority?: number; release?: boolean },
  ): () => void {
    this.assertNotDestroyed()

    const hook: RegisteredKeyHook = {
      order: this.order++,
      priority: options?.priority ?? 0,
      release: options?.release ?? false,
      fn,
    }

    this.keyHooks = sortByPriorityAndOrder([...this.keyHooks, hook])

    return () => {
      this.keyHooks = this.keyHooks.filter((candidate) => candidate !== hook)
    }
  }

  public onRawInput(fn: (ctx: KeymapRawInputContext) => void, options?: { priority?: number }): () => void {
    this.assertNotDestroyed()

    const hook: RegisteredRawHook = {
      order: this.order++,
      priority: options?.priority ?? 0,
      fn,
    }

    this.rawHooks = sortByPriorityAndOrder([...this.rawHooks, hook])

    return () => {
      this.rawHooks = this.rawHooks.filter((candidate) => candidate !== hook)
    }
  }

  public registerCommands(commands: KeymapCommand[]): () => void {
    this.assertNotDestroyed()

    return this.runWithStateChangeBatch(() => {
      const normalizedCommands = commands.map((command) => {
        const mergedAttrs: KeymapAttributes = {}

        for (const [fieldName, value] of Object.entries(command)) {
          if (RESERVED_COMMAND_FIELDS.has(fieldName)) {
            continue
          }

          if (value === undefined) {
            continue
          }

          const compiler = this.commandFields.get(fieldName)
          if (!compiler) {
            this.warnUnknownField("command", fieldName)
            continue
          }

          compiler(value, {
            attr(name, attributeValue) {
              mergeAttribute(mergedAttrs, name, attributeValue, `field ${fieldName}`)
            },
          })
        }

        const attrs = freezeAttributes(mergedAttrs)
        const normalizedCommand: RegisteredCommand = {
          name: normalizeCommandName(command.name),
          run: command.run,
        }

        if (attrs) {
          normalizedCommand.attrs = attrs
        }

        return normalizedCommand
      })

      const seen = new Set<string>()
      for (const command of normalizedCommands) {
        if (seen.has(command.name)) {
          throw new Error(`Duplicate keymap command "${command.name}" in the same registration batch`)
        }

        if (this.commands.has(command.name)) {
          throw new Error(`Keymap command "${command.name}" is already registered`)
        }

        seen.add(command.name)
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

  private reportHookError(name: KeymapHookName, error: unknown): void {
    if (name === "state") {
      this.logger.error("[Keymap] Error in state change hook:", error)
      return
    }

    if (name === "pendingSequence") {
      this.logger.error("[Keymap] Error in pending sequence hook:", error)
      return
    }

    this.logger.error("[Keymap] Error in unresolved command hook:", error)
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("Keymap manager was already destroyed")
    }
  }

  private normalizeScope(layer: KeymapLayer): KeymapScope {
    if (layer.scope) {
      if (layer.scope !== "global" && !layer.target) {
        throw new Error(`Keymap scope "${layer.scope}" requires a target renderable`)
      }

      return layer.scope
    }

    if (layer.target) {
      return "focus-within"
    }

    return "global"
  }

  private compileLayerRuntimeState(layer: KeymapLayer): {
    requires: readonly [name: string, value: unknown][]
    matchers: readonly RuntimeMatcher[]
    conditionKeys: readonly string[]
    hasUnkeyedMatchers: boolean
    compileFields?: Readonly<Record<string, unknown>>
  } {
    const mergedRequires: KeymapEventData = {}
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
        match(matcher, options) {
          const keys = options?.keys ? [...options.keys] : []
          if (keys.length === 0) {
            hasUnkeyedMatchers = true
          } else {
            for (const key of keys) {
              conditionKeys.add(key)
            }
          }

          matchers.push({
            source: `field ${fieldName}`,
            match: matcher,
            keys,
          })
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
          this.compileBindings(layer.bindingInputs, nextTokens, layer.scope, layer.target, layer.order, layer.compileFields),
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

    const resolved = this.resolveBindingCommand(binding.command)
    if (!resolved) {
      if (typeof binding.command === "string") {
        this.handleUnresolvedCommand(binding.command, binding)
      }

      return
    }

    binding.run = resolved.run
    binding.commandAttrs = resolved.attrs
  }

  private resolveBindingCommand(command: KeymapBindingCommand | undefined): KeymapResolvedBindingCommand | undefined {
    if (command === undefined) {
      return undefined
    }

    if (typeof command === "function") {
      return { run: command }
    }

    const registered = this.commands.get(command)
    if (registered) {
      return {
        run: this.createRegisteredCommandRunner(registered),
        attrs: registered.attrs,
      }
    }

    const context: KeymapCommandResolverContext = {
      getCommandAttrs: (name) => {
        return this.commands.get(name)?.attrs
      },
    }

    for (const resolver of this.commandResolvers) {
      const resolved = resolver(command, context)
      if (resolved) {
        return resolved
      }
    }

    return undefined
  }

  private createRegisteredCommandRunner(command: RegisteredCommand): KeymapCommandHandler {
    return (ctx) => {
      return command.run({
        ...ctx,
        command: this.createCommandInfo(command),
      })
    }
  }

  private createCommandInfo(command: RegisteredCommand): KeymapCommandInfo {
    return command.attrs ? { name: command.name, attrs: command.attrs } : { name: command.name }
  }

  private getBindingSyntax(): KeymapBindingSyntax {
    const syntax = this.bindingSyntax
    if (!syntax) {
      throw new Error("No keymap binding syntax is registered")
    }

    return syntax
  }

  private normalizeTokenName(token: string): string {
    const normalized = this.getBindingSyntax().normalizeTokenName(token)
    if (!normalized) {
      throw new Error("Invalid keymap token: token cannot be empty")
    }

    return normalized
  }

  private parseObjectKeyPart(key: KeyStroke): ParsedKeyPart {
    const parsed = this.getBindingSyntax().parseObjectKey(key)
    return createParsedKeyPart(parsed.stroke, parsed.display, parsed.matchKey)
  }

  private normalizeBindingEvent(event: unknown): KeymapBindingEvent {
    if (event === undefined || event === "press") {
      return "press"
    }

    if (event === "release") {
      return "release"
    }

    throw new Error(`Invalid keymap binding event "${String(event)}": expected "press" or "release"`)
  }

  private compileBindings(
    bindings: readonly KeymapBindingInput[],
    tokens: ReadonlyMap<string, ParsedKeyToken>,
    sourceScope: KeymapScope,
    sourceTarget: Renderable | undefined,
    sourceLayerOrder: number,
    compileFields?: Readonly<Record<string, unknown>>,
  ): CompiledBindingsResult {
    const root = createSequenceNode(null, null, null)
    const compiledBindings: CompiledBinding[] = []
    let hasTokenBindings = false

    for (const [bindingIndex, binding] of bindings.entries()) {
      const expandedBindingKeys = expandBindingInputWithExpanders(binding.key, this.bindingExpanders, {
        layer: compileFields,
      })

      for (const expandedBindingKey of expandedBindingKeys) {
        const parsed =
          typeof expandedBindingKey === "string"
            ? parseBindingSequenceWithParsers(expandedBindingKey, this.bindingParsers, {
                tokens,
                layer: compileFields,
              })
            : {
                parts: [this.parseObjectKeyPart(expandedBindingKey)],
                usedTokens: [] as readonly string[],
                unknownTokens: [] as readonly string[],
                hasTokenBindings: false,
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
          const event = this.normalizeBindingEvent(compiledInput.event)
          const mergedRequires: KeymapEventData = {}
          const mergedAttrs: KeymapAttributes = {}
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
              match(matcher, options) {
                const keys = options?.keys ? [...options.keys] : []
                if (keys.length === 0) {
                  hasUnkeyedMatchers = true
                } else {
                  for (const key of keys) {
                    conditionKeys.add(key)
                  }
                }

                matchers.push({
                  source: `field ${fieldName}`,
                  match: matcher,
                  keys,
                })
              },
            })
          }

          const attrs = freezeAttributes(mergedAttrs)
          const command = normalizeBindingCommand(bindingFields.cmd)
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
            consume: bindingFields.consume !== false,
            fallthrough: bindingFields.fallthrough ?? false,
          }

          if (attrs) {
            compiledBinding.attrs = attrs
          }

          this.resolveCompiledBindingCommand(compiledBinding)

          if (sequence.length === 0) {
            continue
          }

          if (event === "release" && sequence.length > 1) {
            throw new Error("Keymap release bindings only support a single key stroke")
          }

          compiledBindings.push(compiledBinding)

          if (event === "press") {
            this.insertBinding(root, compiledBinding)
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
    binding: KeymapBindingInput,
    sequence: ParsedKeyPart[],
    compileFields?: Readonly<Record<string, unknown>>,
  ): KeymapParsedBindingInput[] {
    if (this.bindingCompilers.length === 0) {
      return [{ ...binding, sequence: sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)) }]
    }

    const parsedBinding: KeymapParsedBindingInput = {
      ...binding,
      sequence: sequence.map((part) => createParsedKeyPart(part.stroke, part.display, part.matchKey)),
    }
    const extraBindings: KeymapParsedBindingInput[] = []
    let keepOriginal = true
    const layer = compileFields ?? EMPTY_COMPILE_FIELDS

    for (const compiler of this.bindingCompilers) {
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
        this.logger.error("[Keymap] Error in binding compiler:", error)
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

    for (const part of binding.sequence) {
      if (node.bindings.some((candidate) => candidate.command !== undefined)) {
        throw new Error(
          "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
        )
      }

      const bindingKey = part.matchKey
      let child = node.children.get(bindingKey)
      if (!child) {
        child = createSequenceNode(node, part.stroke, part.matchKey)
        node.children.set(bindingKey, child)
      }

      child.reachableBindings.push(binding)
      node = child
    }

    if (binding.command !== undefined && node.children.size > 0) {
      throw new Error(
        "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
      )
    }

    node.bindings = [...node.bindings, binding]
  }

  private handleRawSequence(sequence: string): boolean {
    if (this.destroyed) {
      return false
    }

    if (this.rawHooks.length === 0) {
      return false
    }

    let stopped = false
    const hooks = [...this.rawHooks]
    const context: KeymapRawInputContext = {
      sequence,
      stop() {
        stopped = true
      },
    }

    for (const hook of hooks) {
      try {
        hook.fn(context)
      } catch (error) {
        this.logger.error("[Keymap] Error in raw input hook:", error)
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

    const hooks = this.keyHooks
    const context: KeymapKeyInputContext = {
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
        hook.fn(context)
      } catch (error) {
        this.logger.error("[Keymap] Error in key input hook:", error)
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
      if (hasLayerConditions && !this.layerHasNoConditions(layer) && !this.matchesLayerConditions(layer)) {
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
      if (hasLayerConditions && !this.layerHasNoConditions(layer) && !this.matchesLayerConditions(layer)) {
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
    if (this.eventMatchResolvers.length === 0) {
      return []
    }

    if (this.eventMatchResolvers.length === 1) {
      const resolver = this.eventMatchResolvers[0]!

      let resolved: readonly string[] | undefined
      try {
        resolved = resolver(event)
      } catch (error) {
        this.logger.error("[Keymap] Error in event match resolver:", error)
        return []
      }

      if (!resolved || resolved.length === 0) {
        return []
      }

      if (resolved.length === 1) {
        const [candidate] = resolved
        if (typeof candidate !== "string" || !candidate) {
          this.logger.error("[Keymap] Invalid event match resolver candidate:", candidate)
          return []
        }

        return [candidate]
      }

      const keys: string[] = []
      const seen = new Set<string>()
      for (const candidate of resolved) {
        if (typeof candidate !== "string") {
          this.logger.error("[Keymap] Invalid event match resolver candidate:", candidate)
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

    for (const resolver of this.eventMatchResolvers) {
      let resolved: readonly string[] | undefined

      try {
        resolved = resolver(event)
      } catch (error) {
        this.logger.error("[Keymap] Error in event match resolver:", error)
        continue
      }

      if (!resolved || resolved.length === 0) {
        continue
      }

      for (const candidate of resolved) {
        if (typeof candidate !== "string") {
          this.logger.error("[Keymap] Invalid event match resolver candidate:", candidate)
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

      if (!this.matchesBindingConditions(binding)) {
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
      if (this.matchesBindingConditions(binding) && this.isVisibleBinding(binding)) {
        matches.push(binding)
      }
    }

    return matches
  }

  private hasMatchingBindings(bindings: readonly CompiledBinding[]): boolean {
    for (const binding of bindings) {
      if (this.matchesBindingConditions(binding) && this.isVisibleBinding(binding)) {
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

  private toActiveBinding(binding: CompiledBinding): KeymapActiveBinding {
    if (binding.activeBindingCacheVersion === this.commandMetadataVersion) {
      const cached = binding.activeBindingCache
      if (cached) {
        return cached
      }
    }

    const activeBinding: KeymapActiveBinding = {
      sequence: binding.sequence,
      command: binding.command,
      commandAttrs: binding.commandAttrs,
      attrs: binding.attrs,
      event: binding.event,
      consume: binding.consume,
      fallthrough: binding.fallthrough,
    }

    binding.activeBindingCacheVersion = this.commandMetadataVersion
    binding.activeBindingCache = activeBinding
    return activeBinding
  }

  private collectActiveBindings(bindings: readonly CompiledBinding[]): KeymapActiveBinding[] {
    return bindings.map((binding) => this.toActiveBinding(binding))
  }

  private getActiveCommandAttrs(binding: CompiledBinding): Readonly<KeymapAttributes> | undefined {
    return binding.commandAttrs
  }

  private collectActiveKeysAtRoot(
    activeLayers: RegisteredLayer[],
    includeBindings: boolean,
    includeMetadata: boolean,
  ): readonly KeymapActiveKey[] {
    const activeKeys = new Map<string, ActiveKeyState>()
    const stopped = new Set<string>()
    const hasLayerConditions = this.layersWithConditions > 0

    for (const layer of activeLayers) {
      if (hasLayerConditions && !this.layerHasNoConditions(layer) && !this.matchesLayerConditions(layer)) {
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

    const materialized: KeymapActiveKey[] = []
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
  ): readonly KeymapActiveKey[] {
    const activeKeys: KeymapActiveKey[] = []

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
      if (!this.matchesBindingConditions(binding) || !this.isVisibleBinding(binding)) {
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
  ): KeymapActiveKey | undefined {
    if (!state.commandBinding && !state.continues) {
      return undefined
    }

    const activeKey: KeymapActiveKey = {
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
      if (!this.matchesBindingConditions(binding)) {
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

    const context: KeymapCommandContext = {
      manager: this,
      renderer: this.renderer,
      event,
      focused,
      target: layer.target ?? null,
      data: this.getReadonlyData(),
    }

    let result: KeymapCommandResult
    try {
      result = run(context)
    } catch (error) {
      this.logger.error(`[Keymap] Error running command ${this.describeBindingCommand(binding)}:`, error)
      this.applyBindingEventEffects(binding, event)
      return true
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        this.logger.error(`[Keymap] Async error in command ${this.describeBindingCommand(binding)}:`, error)
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
    if (!binding.consume) {
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
    if (target.conditionKeys.length === 0) {
      return
    }

    for (const key of target.conditionKeys) {
      const dependents = this.runtimeKeyDependents.get(key)
      if (dependents) {
        dependents.add(target)
        continue
      }

      this.runtimeKeyDependents.set(key, new Set([target]))
    }

    if (!target.hasUnkeyedMatchers) {
      target.matchCacheDirty = true
    }
  }

  private unregisterRuntimeMatchable(target: RuntimeMatchable): void {
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
    if (target.hasUnkeyedMatchers || target.conditionKeys.length === 0) {
      return false
    }

    return target.matchCacheDirty !== true && target.matchCache !== undefined
  }

  private updateConditionCache(target: RuntimeMatchable, matched: boolean): void {
    if (target.hasUnkeyedMatchers || target.conditionKeys.length === 0) {
      return
    }

    target.matchCacheDirty = false
    target.matchCache = matched
  }

  private matchesRuntimeMatcher(matcher: RuntimeMatcher): boolean {
    try {
      return matcher.match()
    } catch (error) {
      this.logger.error(`[Keymap] Error evaluating runtime matcher from ${matcher.source}:`, error)
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

  private matchesBindingConditions(binding: CompiledBinding): boolean {
    return this.matchesConditions(binding)
  }

  private matchesLayerConditions(layer: RegisteredLayer): boolean {
    return this.matchesConditions(layer)
  }

  private layerHasNoConditions(layer: RegisteredLayer): boolean {
    return this.hasNoConditions(layer)
  }

  private layerMatchesRuntimeState(layer: RegisteredLayer): boolean {
    if (this.layersWithConditions === 0 || this.layerHasNoConditions(layer)) {
      return true
    }

    return this.matchesLayerConditions(layer)
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

  private getReadonlyData(): Readonly<KeymapEventData> {
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
      `[Keymap] Unresolved command "${command}" for binding "${sequence}" in ${binding.sourceScope} layer`,
    )

    if (!this.hooks.has("unresolvedCommand")) {
      return
    }

    const context: KeymapUnresolvedCommandContext = {
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
    this.logger.warn(message)
  }

  private warnUnknownField(kind: "binding" | "layer" | "command", fieldName: string): void {
    this.warnOnce(`${kind}:${fieldName}`, `[Keymap] Unknown ${kind} field "${fieldName}" was ignored`)
  }

  private warnUnknownToken(token: string, sequence: string): void {
    this.warnOnce(`token:${token}`, `[Keymap] Unknown token "${token}" in key sequence "${sequence}" was ignored`)
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

export function getKeymapManager(renderer: CliRenderer, options?: KeymapManagerOptions): KeymapManager {
  const existing = keymapManagersByRenderer.get(renderer)
  if (existing) {
    if (existing.isDestroyed) {
      keymapManagersByRenderer.delete(renderer)
    } else {
      existing.applyOptions(options)
      return existing
    }
  }

  const manager = new KeymapManagerImpl(renderer, options)
  keymapManagersByRenderer.set(renderer, manager)

  renderer.once("destroy", () => {
    manager.destroy()
    keymapManagersByRenderer.delete(renderer)
  })

  return manager
}
