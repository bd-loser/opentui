import { RenderableEvents, type Renderable } from "../../Renderable.js"
import { CliRenderEvents, type CliRenderer } from "../../renderer.js"
import type { KeyEvent } from "../../lib/KeyHandler.js"
import {
  cloneStroke,
  createParsedKeyPart,
  normalizeBindingInputs,
  normalizeCommandName,
  normalizeEventKeyStroke,
  normalizeTokenName,
  parseCommandInput,
  parseKeyLike,
  parseKeySequenceLike,
  stringifyKeyStroke,
} from "./utils.js"

export type KeymapEventData = Record<string, unknown>

export type KeymapAttributes = Record<string, unknown>

export interface KeyStroke {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
}

export interface ParsedKeyStroke extends KeyStroke {
  ctrl: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

export interface ParsedKeyPart {
  stroke: ParsedKeyStroke
  display: string
}

export interface KeymapStringifyOptions {
  preferDisplay?: boolean
}

export type KeymapStringifiableKey = ParsedKeyStroke | ParsedKeyPart | { stroke: ParsedKeyStroke; display?: string }

export type KeyLike = string | KeyStroke

export type KeymapBindingInput = {
  key: KeyLike
  cmd: string
  consume?: boolean
  fallthrough?: boolean
} & Record<string, unknown>

export type KeymapBindingShorthand = Record<string, string>

export type KeymapBindings = KeymapBindingInput[] | KeymapBindingShorthand

export type KeymapScope = "global" | "focus" | "focus-within"

export interface KeymapLayerFields {
  priority?: number
  bindings: KeymapBindings
  [key: string]: unknown
}

export interface KeymapGlobalLayer extends KeymapLayerFields {
  target?: undefined
  scope?: "global"
}

export interface KeymapFocusWithinLayer extends KeymapLayerFields {
  target: Renderable
  scope?: "focus-within"
}

export interface KeymapFocusLayer extends KeymapLayerFields {
  target: Renderable
  scope: "focus"
}

export type KeymapTargetLayer = KeymapFocusWithinLayer | KeymapFocusLayer

export type KeymapLayer = KeymapGlobalLayer | KeymapTargetLayer

export interface KeymapResolvedCommand {
  input: string
  name: string
  args: string[]
  attrs?: Readonly<KeymapAttributes>
}

export interface KeymapCommandContext {
  manager: KeymapManager
  renderer: CliRenderer
  event: KeyEvent
  focused: Renderable | null
  target: Renderable | null
  data: Readonly<KeymapEventData>
  command: KeymapResolvedCommand
}

export type KeymapCommandResult = boolean | void | Promise<boolean | void>

export interface KeymapCommand {
  name: string
  run: (ctx: KeymapCommandContext) => KeymapCommandResult
  [key: string]: unknown
}

export type ActionCommand = KeymapCommand

export interface ExCommand {
  name: string
  aliases?: string[]
  nargs?: "0" | "1" | "?" | "*" | "+"
  run: (ctx: KeymapCommandContext & { raw: string; args: string[] }) => void | Promise<void>
  [key: string]: unknown
}

export interface KeymapToken {
  token: string
  key: KeyLike
}

export interface KeymapActiveBinding {
  sequence: ParsedKeyPart[]
  command: KeymapResolvedCommand
  attrs?: Readonly<KeymapAttributes>
  consume: boolean
  fallthrough: boolean
}

export interface KeymapActiveKeyOptions {
  includeBindings?: boolean
  includeMetadata?: boolean
}

export interface KeymapActiveKey {
  stroke: ParsedKeyStroke
  display: string
  bindings?: KeymapActiveBinding[]
  bindingAttrs?: Readonly<KeymapAttributes>
  commandAttrs?: Readonly<KeymapAttributes>
  command?: KeymapResolvedCommand
  continues: boolean
}

export interface KeymapBindingFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
  match(matcher: () => boolean, options?: { keys?: readonly string[] }): void
}

export type KeymapBindingFieldCompiler = (value: unknown, ctx: KeymapBindingFieldContext) => void

export interface KeymapLayerFieldContext {
  require(name: string, value: unknown): void
  match(matcher: () => boolean, options?: { keys?: readonly string[] }): void
}

export type KeymapLayerFieldCompiler = (value: unknown, ctx: KeymapLayerFieldContext) => void

export interface KeymapCommandFieldContext {
  attr(name: string, value: unknown): void
}

export type KeymapCommandFieldCompiler = (value: unknown, ctx: KeymapCommandFieldContext) => void

export interface KeymapKeyInputContext {
  event: KeyEvent
  setData: (name: string, value: unknown) => void
  getData: (name: string) => unknown
  consume: (options?: { preventDefault?: boolean; stopPropagation?: boolean }) => void
}

export interface KeymapRawInputContext {
  sequence: string
  stop: () => void
}

export interface KeymapManager {
  readonly renderer: CliRenderer
  destroy(): void
  setData(name: string, value: unknown): void
  getData(name: string): unknown
  invalidateRuntimeKey(name: string): void
  getPendingSequence(): readonly ParsedKeyStroke[]
  getPendingSequenceParts(): readonly ParsedKeyPart[]
  clearPendingSequence(): void
  popPendingSequence(): boolean
  getActiveKeys(options?: KeymapActiveKeyOptions): readonly KeymapActiveKey[]
  onStateChange(fn: () => void): () => void
  onPendingSequenceChange(fn: (sequence: readonly ParsedKeyStroke[]) => void): () => void
  registerLayer(layer: KeymapLayer): () => void
  registerLayerFields(fields: Record<string, KeymapLayerFieldCompiler>): () => void
  registerToken(token: KeymapToken): () => void
  registerBindingFields(fields: Record<string, KeymapBindingFieldCompiler>): () => void
  registerCommandFields(fields: Record<string, KeymapCommandFieldCompiler>): () => void
  onKeyInput(fn: (ctx: KeymapKeyInputContext) => void, options?: { priority?: number; release?: boolean }): () => void
  onRawInput(fn: (ctx: KeymapRawInputContext) => void, options?: { priority?: number }): () => void
  registerCommands(commands: KeymapCommand[]): () => void
}

interface RuntimeMatcher {
  source: string
  match: () => boolean
  keys: readonly string[]
}

interface RuntimeMatchable {
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
  hasUnkeyedMatchers: boolean
  matchCacheDirty?: boolean
  matchCache?: boolean
}

interface CompiledBinding extends KeymapActiveBinding, RuntimeMatchable {
  activeBindingCacheVersion?: number
  activeBindingCache?: KeymapActiveBinding
}

interface DispatchActiveKeyResult {
  activeKey: KeymapActiveKey
  stop: boolean
}

interface RegisteredCommand {
  name: string
  run: (ctx: KeymapCommandContext) => KeymapCommandResult
  attrs?: Readonly<KeymapAttributes>
}

interface CompiledBindingsResult {
  root: SequenceNode
  bindings: readonly CompiledBinding[]
}

interface SequenceNode {
  parent: SequenceNode | null
  depth: number
  stroke: ParsedKeyStroke | null
  children: Map<string, SequenceNode>
  bindings: CompiledBinding[]
  reachableBindings: CompiledBinding[]
}

interface RegisteredLayer {
  order: number
  target?: Renderable
  scope: KeymapScope
  priority: number
  requires: readonly [name: string, value: unknown][]
  matchers: readonly RuntimeMatcher[]
  conditionKeys: readonly string[]
  hasUnkeyedMatchers: boolean
  matchCacheDirty?: boolean
  matchCache?: boolean
  bindingInputs: readonly KeymapBindingInput[]
  compiledBindings: readonly CompiledBinding[]
  hasUnkeyedBindings: boolean
  hasTokenBindings: boolean
  root: SequenceNode
  offTargetDestroy?: () => void
  bucket?: RegisteredLayerBucket
}

interface RegisteredLayerBucket {
  focusLayers: RegisteredLayer[]
  focusWithinLayers: RegisteredLayer[]
}

interface RegisteredKeyHook {
  order: number
  priority: number
  release: boolean
  fn: (ctx: KeymapKeyInputContext) => void
}

interface RegisteredRawHook {
  order: number
  priority: number
  fn: (ctx: KeymapRawInputContext) => void
}

interface PendingSequenceState {
  layer: RegisteredLayer
  node: SequenceNode
}

const keymapManagersByRenderer = new WeakMap<CliRenderer, KeymapManagerImpl>()

export const RESERVED_BINDING_FIELDS = new Set(["key", "cmd", "consume", "fallthrough"])

const RESERVED_LAYER_FIELDS = new Set(["target", "scope", "priority", "bindings"])

const RESERVED_COMMAND_FIELDS = new Set(["name", "run"])

function isPromiseLike(value: unknown): value is Promise<unknown> {
  if (!value) {
    return false
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return false
  }

  return typeof (value as { then?: unknown }).then === "function"
}

function sortByPriorityAndOrder<T extends { priority: number; order: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const priorityDiff = b.priority - a.priority
    if (priorityDiff !== 0) {
      return priorityDiff
    }

    return a.order - b.order
  })
}

function sortLayersWithinScope(items: RegisteredLayer[]): RegisteredLayer[] {
  return [...items].sort((a, b) => {
    const priorityDiff = b.priority - a.priority
    if (priorityDiff !== 0) {
      return priorityDiff
    }

    return b.order - a.order
  })
}

function buildBindingKey(stroke: ParsedKeyStroke): string {
  return `${stroke.name}:${stroke.ctrl ? 1 : 0}:${stroke.shift ? 1 : 0}:${stroke.meta ? 1 : 0}:${stroke.super ? 1 : 0}`
}

function createSequenceNode(parent: SequenceNode | null, stroke: ParsedKeyStroke | null): SequenceNode {
  return {
    parent,
    depth: parent ? parent.depth + 1 : 0,
    stroke,
    children: new Map(),
    bindings: [],
    reachableBindings: [],
  }
}

function mergeRequirement(target: KeymapEventData, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap requirement for "${name}" from ${source}`)
  }

  target[name] = value
}

function mergeAttribute(target: KeymapAttributes, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap attribute for "${name}" from ${source}`)
  }

  target[name] = value
}

function freezeAttributes(attrs: KeymapAttributes): Readonly<KeymapAttributes> | undefined {
  if (Object.keys(attrs).length === 0) {
    return undefined
  }

  return Object.freeze({ ...attrs })
}

function cloneBindingInput(binding: KeymapBindingInput): KeymapBindingInput {
  return {
    ...binding,
    key: typeof binding.key === "string" ? binding.key : { ...binding.key },
  }
}

function snapshotBindingInputs(bindings: KeymapBindings): KeymapBindingInput[] {
  return normalizeBindingInputs(bindings).map((binding) => cloneBindingInput(binding))
}

function bindingUsesTokenSyntax(binding: KeymapBindingInput): boolean {
  return typeof binding.key === "string" && binding.key.includes("<")
}

class KeymapManagerImpl implements KeymapManager {
  public readonly renderer: CliRenderer

  private layers = new Set<RegisteredLayer>()
  private globalLayers: RegisteredLayer[] = []
  private targetLayers = new WeakMap<Renderable, RegisteredLayerBucket>()
  private tokens = new Map<string, ParsedKeyStroke>()
  private layerFields = new Map<string, KeymapLayerFieldCompiler>()
  private bindingFields = new Map<string, KeymapBindingFieldCompiler>()
  private commandFields = new Map<string, KeymapCommandFieldCompiler>()
  private runtimeKeyDependents = new Map<string, Set<RuntimeMatchable>>()
  private keyHooks: RegisteredKeyHook[] = []
  private rawHooks: RegisteredRawHook[] = []
  private stateChangeListeners: Array<() => void> = []
  private pendingSequenceListeners: Array<(sequence: readonly ParsedKeyStroke[]) => void> = []
  private commands = new Map<string, RegisteredCommand>()
  private commandsWithAttrs = 0
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

  private readonly keypressListener: (event: KeyEvent) => void
  private readonly keyreleaseListener: (event: KeyEvent) => void
  private readonly rawListener: (sequence: string) => boolean
  private readonly focusedRenderableListener: (focused: Renderable | null) => void

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
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
      layer.offTargetDestroy?.()
      layer.offTargetDestroy = undefined
      layer.bucket = undefined
    }

    this.destroyed = true
    this.layers.clear()
    this.globalLayers = []
    this.targetLayers = new WeakMap()
    this.tokens.clear()
    this.layerFields.clear()
    this.bindingFields.clear()
    this.commandFields.clear()
    this.runtimeKeyDependents.clear()
    this.keyHooks = []
    this.rawHooks = []
    this.stateChangeListeners = []
    this.pendingSequenceListeners = []
    this.commands.clear()
    this.commandsWithAttrs = 0
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
        this.resolvePendingSequence()
        this.queueStateChange()
        return
      }

      if (Object.is(this.data[name], value)) {
        return
      }

      this.data[name] = value
      this.dataVersion += 1
      this.invalidateRuntimeConditionKey(name)
      this.resolvePendingSequence()
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
      this.resolvePendingSequence()
      this.queueStateChange()
    })
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    this.assertNotDestroyed()

    if (this.pendingSequenceCacheVersion === this.derivedStateVersion) {
      return this.pendingSequenceCache
    }

    const pending = this.resolvePendingSequence()
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

    const pending = this.resolvePendingSequence()
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

    const pending = this.resolvePendingSequence()
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
    const pending = this.resolvePendingSequence(focused)
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

  public onStateChange(fn: () => void): () => void {
    this.assertNotDestroyed()

    this.stateChangeListeners = [...this.stateChangeListeners, fn]

    return () => {
      this.stateChangeListeners = this.stateChangeListeners.filter((candidate) => candidate !== fn)
    }
  }

  public onPendingSequenceChange(fn: (sequence: readonly ParsedKeyStroke[]) => void): () => void {
    this.assertNotDestroyed()

    this.pendingSequenceListeners = [...this.pendingSequenceListeners, fn]

    return () => {
      this.pendingSequenceListeners = this.pendingSequenceListeners.filter((candidate) => candidate !== fn)
    }
  }

  public registerLayer(layer: KeymapLayer): () => void {
    this.assertNotDestroyed()

    return this.runWithStateChangeBatch(() => {
      const scope = this.normalizeScope(layer)
      const bindingInputs = snapshotBindingInputs(layer.bindings)
      const { requires, matchers, conditionKeys, hasUnkeyedMatchers } = this.compileLayerRuntimeState(layer)
      const compiledBindings = this.compileBindings(bindingInputs, this.tokens)
      const target = layer.target
      if (target && target.isDestroyed) {
        throw new Error("Cannot register a keymap layer for a destroyed renderable")
      }

      const registeredLayer: RegisteredLayer = {
        order: this.order++,
        target,
        scope,
        priority: layer.priority ?? 0,
        requires,
        matchers,
        conditionKeys,
        hasUnkeyedMatchers,
        matchCacheDirty: true,
        bindingInputs,
        compiledBindings: compiledBindings.bindings,
        hasUnkeyedBindings: compiledBindings.bindings.some((binding) => binding.hasUnkeyedMatchers),
        hasTokenBindings: bindingInputs.some((binding) => bindingUsesTokenSyntax(binding)),
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

  public registerToken(token: KeymapToken): () => void {
    this.assertNotDestroyed()

    const normalizedToken = normalizeTokenName(token.token)
    if (!normalizedToken.startsWith("<") || !normalizedToken.endsWith(">")) {
      throw new Error(`Invalid token "${token.token}": tokens must use angle-bracket syntax like <leader>`)
    }

    if (this.tokens.has(normalizedToken)) {
      throw new Error(`Keymap token "${normalizedToken}" is already registered`)
    }

    const registeredToken = parseKeyLike(token.key)

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
            throw new Error(`Unknown keymap command field "${fieldName}"`)
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
        if (command.attrs) {
          this.commandsWithAttrs += 1
        }
      }

      if (normalizedCommands.length > 0) {
        this.commandMetadataVersion += 1
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

            if (command.attrs) {
              this.commandsWithAttrs -= 1
            }

            this.commands.delete(command.name)
            removed = true
          }

          if (removed) {
            this.commandMetadataVersion += 1
            this.queueStateChange()
          }
        })
      }
    })
  }

  private handleFocusedRenderableChange(focused: Renderable | null): void {
    this.runWithStateChangeBatch(() => {
      this.resolvePendingSequence(focused)
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

    if (this.stateChangeListeners.length === 0) {
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

        const listeners = [...this.stateChangeListeners]
        for (const listener of listeners) {
          try {
            listener()
          } catch (error) {
            console.error("[Keymap] Error in state change hook:", error)
          }
        }
      }
    } finally {
      this.flushingStateChange = false
    }
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
  } {
    const mergedRequires: KeymapEventData = {}
    const matchers: RuntimeMatcher[] = []
    const conditionKeys = new Set<string>()
    let hasUnkeyedMatchers = false

    for (const [fieldName, value] of Object.entries(layer)) {
      if (RESERVED_LAYER_FIELDS.has(fieldName)) {
        continue
      }

      if (value === undefined) {
        continue
      }

      const compiler = this.layerFields.get(fieldName)
      if (!compiler) {
        throw new Error(`Unknown keymap layer field "${fieldName}"`)
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
      this.globalLayers = sortLayersWithinScope([...this.globalLayers, layer])
      return
    }

    const target = layer.target
    if (!target) {
      return
    }

    const bucket = this.getOrCreateTargetBucket(target)
    if (layer.scope === "focus") {
      bucket.focusLayers = sortLayersWithinScope([...bucket.focusLayers, layer])
    } else {
      bucket.focusWithinLayers = sortLayersWithinScope([...bucket.focusWithinLayers, layer])
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

  private applyTokenState(nextTokens: Map<string, ParsedKeyStroke>): void {
    this.runWithStateChangeBatch(() => {
      const nextCompilations = new Map<RegisteredLayer, CompiledBindingsResult>()

      for (const layer of this.layers) {
        if (!layer.hasTokenBindings) {
          continue
        }

        nextCompilations.set(layer, this.compileBindings(layer.bindingInputs, nextTokens))
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

  private compileBindings(
    bindings: readonly KeymapBindingInput[],
    tokens: ReadonlyMap<string, ParsedKeyStroke>,
  ): CompiledBindingsResult {
    const root = createSequenceNode(null, null)
    const compiledBindings: CompiledBinding[] = []

    for (const binding of bindings) {
      const sequence = parseKeySequenceLike(binding.key, tokens)
      const mergedRequires: KeymapEventData = {}
      const mergedAttrs: KeymapAttributes = {}
      const matchers: RuntimeMatcher[] = []
      const conditionKeys = new Set<string>()
      let hasUnkeyedMatchers = false

      for (const [fieldName, value] of Object.entries(binding)) {
        if (RESERVED_BINDING_FIELDS.has(fieldName)) {
          continue
        }

        if (value === undefined) {
          continue
        }

        const compiler = this.bindingFields.get(fieldName)
        if (!compiler) {
          throw new Error(`Unknown keymap binding field "${fieldName}"`)
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
      const compiledBinding: CompiledBinding = {
        sequence,
        command: parseCommandInput(binding.cmd),
        requires: Object.entries(mergedRequires),
        matchers,
        conditionKeys: [...conditionKeys],
        hasUnkeyedMatchers,
        matchCacheDirty: true,
        consume: binding.consume !== false,
        fallthrough: binding.fallthrough ?? false,
      }

      if (attrs) {
        compiledBinding.attrs = attrs
      }

      if (sequence.length === 0) {
        continue
      }

      compiledBindings.push(compiledBinding)
      this.insertBinding(root, compiledBinding)
    }

    return {
      root,
      bindings: compiledBindings,
    }
  }

  private insertBinding(root: SequenceNode, binding: CompiledBinding): void {
    let node = root

    for (const part of binding.sequence) {
      if (node.bindings.length > 0) {
        throw new Error(
          "Keymap bindings cannot use the same sequence as both an exact match and a prefix in the same layer",
        )
      }

      const bindingKey = buildBindingKey(part.stroke)
      let child = node.children.get(bindingKey)
      if (!child) {
        child = createSequenceNode(node, part.stroke)
        node.children.set(bindingKey, child)
      }

      child.reachableBindings.push(binding)
      node = child
    }

    if (node.children.size > 0) {
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
        console.error("[Keymap] Error in raw input hook:", error)
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
        console.error("[Keymap] Error in key input hook:", error)
      }

      if (event.propagationStopped) {
        return
      }
    }

    if (release) {
      return
    }

    this.dispatchLayers(event)
  }

  private dispatchLayers(event: KeyEvent): void {
    const focused = this.getFocusedRenderable()
    const pending = this.resolvePendingSequence(focused)
    const stroke = normalizeEventKeyStroke(event)

    if (pending) {
      this.dispatchPendingSequence(pending, stroke, event, focused)
      return
    }

    const activeLayers = this.getActiveLayers(focused)
    this.dispatchFromRoot(activeLayers, stroke, event, focused)
  }

  private dispatchPendingSequence(
    pending: PendingSequenceState,
    stroke: ParsedKeyStroke,
    event: KeyEvent,
    focused: Renderable | null,
  ): void {
    const nextNode = this.getReachableChild(pending.node, stroke)
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
    stroke: ParsedKeyStroke,
    event: KeyEvent,
    focused: Renderable | null,
  ): void {
    const hasLayerConditions = this.layersWithConditions > 0

    for (const layer of activeLayers) {
      if (hasLayerConditions && !this.layerHasNoConditions(layer) && !this.matchesLayerConditions(layer)) {
        continue
      }

      const nextNode = this.getReachableChild(layer.root, stroke)
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
    }
  }

  private getReachableChild(node: SequenceNode, stroke: ParsedKeyStroke): SequenceNode | undefined {
    const child = node.children.get(buildBindingKey(stroke))
    if (!child) {
      return undefined
    }

    if (!this.nodeHasReachableBindings(child)) {
      return undefined
    }

    return child
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
      return createParsedKeyPart(candidate.stroke!, this.getNodeDisplay(candidate))
    })
  }

  private collectSequenceStrokesFromNode(node: SequenceNode): ParsedKeyStroke[] {
    return this.collectSequencePartsFromNode(node).map((part) => cloneStroke(part.stroke))
  }

  private getMatchingBindings(bindings: readonly CompiledBinding[]): CompiledBinding[] {
    const matches: CompiledBinding[] = []

    for (const binding of bindings) {
      if (this.matchesBindingConditions(binding)) {
        matches.push(binding)
      }
    }

    return matches
  }

  private hasMatchingBindings(bindings: readonly CompiledBinding[]): boolean {
    for (const binding of bindings) {
      if (this.matchesBindingConditions(binding)) {
        return true
      }
    }

    return false
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

  private resolveCommand(
    command: KeymapResolvedCommand,
    registered = this.commands.get(command.name),
  ): KeymapResolvedCommand {
    if (this.commandsWithAttrs === 0 || !registered?.attrs) {
      return command
    }

    return {
      input: command.input,
      name: command.name,
      args: command.args,
      attrs: registered.attrs,
    }
  }

  private toActiveBinding(binding: CompiledBinding): KeymapActiveBinding {
    if (this.commandsWithAttrs === 0) {
      return binding
    }

    const registered = this.commands.get(binding.command.name)
    if (!registered?.attrs) {
      return binding
    }

    if (binding.activeBindingCacheVersion === this.commandMetadataVersion) {
      const cached = binding.activeBindingCache
      if (cached) {
        return cached
      }
    }

    const command = this.resolveCommand(binding.command, registered)

    const activeBinding: KeymapActiveBinding = {
      sequence: binding.sequence,
      command,
      attrs: binding.attrs,
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
    if (this.commandsWithAttrs === 0) {
      return undefined
    }

    return this.commands.get(binding.command.name)?.attrs
  }

  private collectActiveKeysAtRoot(
    activeLayers: RegisteredLayer[],
    includeBindings: boolean,
    includeMetadata: boolean,
  ): readonly KeymapActiveKey[] {
    const activeKeys = new Map<string, KeymapActiveKey>()
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

        const result = this.createDispatchActiveKey(child, includeBindings, includeMetadata)
        if (!result) {
          continue
        }

        const existing = activeKeys.get(bindingKey)
        if (!existing) {
          activeKeys.set(bindingKey, result.activeKey)
        } else {
          this.appendDispatchActiveKey(existing, result.activeKey, includeBindings)
        }

        if (result.stop) {
          stopped.add(bindingKey)
        }
      }
    }

    return [...activeKeys.values()]
  }

  private collectActiveKeysFromChildren(
    children: ReadonlyMap<string, SequenceNode>,
    includeBindings: boolean,
    includeMetadata: boolean,
  ): readonly KeymapActiveKey[] {
    const activeKeys: KeymapActiveKey[] = []

    for (const child of children.values()) {
      const result = this.createDispatchActiveKey(child, includeBindings, includeMetadata)
      if (!result) {
        continue
      }

      activeKeys.push(result.activeKey)
    }

    return activeKeys
  }

  private createDispatchActiveKey(
    node: SequenceNode,
    includeBindings: boolean,
    includeMetadata: boolean,
  ): DispatchActiveKeyResult | undefined {
    if (node.children.size > 0) {
      return this.createPrefixActiveKey(node, includeBindings, includeMetadata)
    }

    return this.createExactActiveKey(node, includeBindings, includeMetadata)
  }

  private createPrefixActiveKey(
    node: SequenceNode,
    includeBindings: boolean,
    includeMetadata: boolean,
  ): DispatchActiveKeyResult | undefined {
    if (!node.stroke) {
      return undefined
    }

    const partIndex = node.depth - 1
    if (node.reachableBindings.length === 1) {
      const [binding] = node.reachableBindings
      if (!binding || !this.matchesBindingConditions(binding)) {
        return undefined
      }

      return {
        activeKey: this.buildActiveKey(
          node,
          [binding],
          binding.sequence[partIndex]?.display ?? stringifyKeyStroke(node.stroke),
          undefined,
          includeBindings,
          includeMetadata,
        ),
        stop: true,
      }
    }

    const matchingBindings = this.getMatchingBindings(node.reachableBindings)
    if (matchingBindings.length === 0) {
      return undefined
    }

    return {
      activeKey: this.buildActiveKey(
        node,
        matchingBindings,
        this.getNodeDisplay(node, matchingBindings),
        undefined,
        includeBindings,
        includeMetadata,
      ),
      stop: true,
    }
  }

  private createExactActiveKey(
    node: SequenceNode,
    includeBindings: boolean,
    includeMetadata: boolean,
  ): DispatchActiveKeyResult | undefined {
    if (!node.stroke) {
      return undefined
    }

    const partIndex = node.depth - 1
    if (node.bindings.length === 1) {
      const [binding] = node.bindings
      if (!binding || !this.matchesBindingConditions(binding) || !this.commands.has(binding.command.name)) {
        return undefined
      }

      return {
        activeKey: this.buildActiveKey(
          node,
          [binding],
          binding.sequence[partIndex]?.display ?? stringifyKeyStroke(node.stroke),
          binding,
          includeBindings,
          includeMetadata,
        ),
        stop: !binding.fallthrough,
      }
    }

    const selected = this.selectDispatchedBindings(node.bindings)
    if (!selected) {
      return undefined
    }

    const display =
      selected.bindings.length === 1
        ? (selected.bindings[0]?.sequence[partIndex]?.display ?? stringifyKeyStroke(node.stroke))
        : this.getNodeDisplay(node, selected.bindings)

    return {
      activeKey: this.buildActiveKey(
        node,
        selected.bindings,
        display,
        selected.bindings[0],
        includeBindings,
        includeMetadata,
      ),
      stop: selected.stop,
    }
  }

  private selectDispatchedBindings(
    bindings: readonly CompiledBinding[],
  ): { bindings: readonly CompiledBinding[]; stop: boolean } | undefined {
    const selected: CompiledBinding[] = []

    for (const binding of bindings) {
      if (!this.matchesBindingConditions(binding)) {
        continue
      }

      if (!this.commands.has(binding.command.name)) {
        continue
      }

      selected.push(binding)
      if (!binding.fallthrough) {
        return { bindings: selected, stop: true }
      }
    }

    if (selected.length === 0) {
      return undefined
    }

    return { bindings: selected, stop: false }
  }

  private buildActiveKey(
    node: SequenceNode,
    bindings: readonly CompiledBinding[],
    display: string,
    commandBinding: CompiledBinding | undefined,
    includeBindings: boolean,
    includeMetadata: boolean,
  ): KeymapActiveKey {
    const singleBinding = bindings.length === 1 ? bindings[0] : undefined

    const activeKey: KeymapActiveKey = {
      stroke: cloneStroke(node.stroke!),
      display,
      continues: node.children.size > 0,
    }

    if (commandBinding) {
      activeKey.command = this.resolveCommand(commandBinding.command)
    }

    if (includeBindings) {
      activeKey.bindings = singleBinding ? [this.toActiveBinding(singleBinding)] : this.collectActiveBindings(bindings)
    }

    if (includeMetadata) {
      const metadataBinding = singleBinding ?? bindings[0]
      if (metadataBinding?.attrs) {
        activeKey.bindingAttrs = metadataBinding.attrs
      }

      const commandAttrs = metadataBinding ? this.getActiveCommandAttrs(metadataBinding) : undefined
      if (commandAttrs) {
        activeKey.commandAttrs = commandAttrs
      }
    }

    return activeKey
  }

  private appendDispatchActiveKey(activeKey: KeymapActiveKey, next: KeymapActiveKey, includeBindings: boolean): void {
    if (!activeKey.command && next.command) {
      activeKey.command = next.command
    }

    if (next.continues) {
      activeKey.continues = true
    }

    if (activeKey.display !== next.display) {
      activeKey.display = stringifyKeyStroke(activeKey.stroke)
    }

    if (includeBindings) {
      if (!activeKey.bindings) {
        activeKey.bindings = []
      }

      if (next.bindings && next.bindings.length > 0) {
        activeKey.bindings.push(...next.bindings)
      }
    }
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
    const registeredCommand = this.commands.get(binding.command.name)
    if (!registeredCommand) {
      return false
    }

    const context: KeymapCommandContext = {
      manager: this,
      renderer: this.renderer,
      event,
      focused,
      target: layer.target ?? null,
      data: this.getReadonlyData(),
      command: this.resolveCommand(binding.command, registeredCommand),
    }

    let result: KeymapCommandResult
    try {
      result = registeredCommand.run(context)
    } catch (error) {
      console.error(`[Keymap] Error running command "${binding.command.name}":`, error)
      this.applyBindingEventEffects(binding, event)
      return true
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        console.error(`[Keymap] Async error in command "${binding.command.name}":`, error)
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
      console.error(`[Keymap] Error evaluating runtime matcher from ${matcher.source}:`, error)
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
    if (this.pendingSequenceListeners.length === 0) {
      return
    }

    const sequence = this.pendingSequence ? this.collectSequenceStrokesFromNode(this.pendingSequence.node) : []
    const listeners = [...this.pendingSequenceListeners]
    for (const listener of listeners) {
      try {
        listener(sequence)
      } catch (error) {
        console.error("[Keymap] Error in pending sequence hook:", error)
      }
    }
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

  private resolvePendingSequence(focused = this.getFocusedRenderable()): PendingSequenceState | undefined {
    if (!this.pendingSequence) {
      return undefined
    }

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

export function getKeymapManager(renderer: CliRenderer): KeymapManager {
  const existing = keymapManagersByRenderer.get(renderer)
  if (existing) {
    if (existing.isDestroyed) {
      keymapManagersByRenderer.delete(renderer)
    } else {
      return existing
    }
  }

  const manager = new KeymapManagerImpl(renderer)
  keymapManagersByRenderer.set(renderer, manager)

  renderer.once("destroy", () => {
    manager.destroy()
    keymapManagersByRenderer.delete(renderer)
  })

  return manager
}
