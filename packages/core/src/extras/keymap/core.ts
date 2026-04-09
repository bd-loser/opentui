import { RenderableEvents, type Renderable } from "../../Renderable.js"
import type { CliRenderer } from "../../renderer.js"
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

export type KeymapEnabled = boolean | (() => boolean)

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

export interface KeymapLayer {
  target?: Renderable
  scope?: "global" | "focus" | "focus-within"
  priority?: number
  enabled?: KeymapEnabled
  bindings: KeymapBindings
}

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
}

export interface KeymapActiveKey {
  stroke: ParsedKeyStroke
  display: string
  bindings?: KeymapActiveBinding[]
  commands: KeymapResolvedCommand[]
  continues: boolean
}

export interface KeymapBindingFieldContext {
  require(name: string, value: unknown): void
  attr(name: string, value: unknown): void
}

export type KeymapBindingFieldCompiler = (value: unknown, ctx: KeymapBindingFieldContext) => void

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
  getPendingSequence(): readonly ParsedKeyStroke[]
  getPendingSequenceParts(): readonly ParsedKeyPart[]
  clearPendingSequence(): void
  popPendingSequence(): boolean
  getActiveKeys(options?: KeymapActiveKeyOptions): readonly KeymapActiveKey[]
  onPendingSequenceChange(fn: (sequence: readonly ParsedKeyStroke[]) => void): () => void
  registerLayer(layer: KeymapLayer): () => void
  registerToken(token: KeymapToken): () => void
  registerBindingFields(fields: Record<string, KeymapBindingFieldCompiler>): () => void
  registerCommandFields(fields: Record<string, KeymapCommandFieldCompiler>): () => void
  onKeyInput(fn: (ctx: KeymapKeyInputContext) => void, options?: { priority?: number; release?: boolean }): () => void
  onRawInput(fn: (ctx: KeymapRawInputContext) => void, options?: { priority?: number }): () => void
  registerCommands(commands: KeymapCommand[]): () => void
}

interface CompiledBinding extends KeymapActiveBinding {
  requires: readonly [name: string, value: unknown][]
  matchCacheVersion?: number
  matchCache?: boolean
}

interface RegisteredCommand {
  name: string
  run: (ctx: KeymapCommandContext) => KeymapCommandResult
  attrs?: Readonly<KeymapAttributes>
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
  scope: "global" | "focus" | "focus-within"
  priority: number
  enabled?: KeymapEnabled
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

const RESERVED_COMMAND_FIELDS = new Set(["name", "run"])

function resolveEnabled(enabled: KeymapEnabled | undefined): boolean {
  if (enabled === undefined) {
    return true
  }

  if (typeof enabled === "function") {
    try {
      return enabled()
    } catch (error) {
      console.error("[Keymap] Error evaluating enabled predicate:", error)
      return false
    }
  }

  return enabled
}

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

class KeymapManagerImpl implements KeymapManager {
  public readonly renderer: CliRenderer

  private layers = new Set<RegisteredLayer>()
  private globalLayers: RegisteredLayer[] = []
  private targetLayers = new WeakMap<Renderable, RegisteredLayerBucket>()
  private tokens = new Map<string, ParsedKeyStroke>()
  private bindingFields = new Map<string, KeymapBindingFieldCompiler>()
  private commandFields = new Map<string, KeymapCommandFieldCompiler>()
  private keyHooks: RegisteredKeyHook[] = []
  private rawHooks: RegisteredRawHook[] = []
  private pendingSequenceListeners: Array<(sequence: readonly ParsedKeyStroke[]) => void> = []
  private commands = new Map<string, RegisteredCommand>()
  private commandsWithAttrs = 0
  private data: KeymapEventData = {}
  private dataVersion = 0
  private readonlyDataVersion = -1
  private readonlyData: Readonly<KeymapEventData> = Object.freeze({})
  private pendingSequence: PendingSequenceState | null = null
  private order = 0
  private destroyed = false

  private readonly keypressListener: (event: KeyEvent) => void
  private readonly keyreleaseListener: (event: KeyEvent) => void
  private readonly rawListener: (sequence: string) => boolean

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

    this.renderer.keyInput.prependListener("keypress", this.keypressListener)
    this.renderer.keyInput.prependListener("keyrelease", this.keyreleaseListener)
    this.renderer.prependInputHandler(this.rawListener)
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
    this.bindingFields.clear()
    this.commandFields.clear()
    this.keyHooks = []
    this.rawHooks = []
    this.pendingSequenceListeners = []
    this.commands.clear()
    this.commandsWithAttrs = 0
    this.data = {}
    this.dataVersion = 0
    this.readonlyDataVersion = -1
    this.readonlyData = Object.freeze({})

    this.renderer.keyInput.off("keypress", this.keypressListener)
    this.renderer.keyInput.off("keyrelease", this.keyreleaseListener)
    this.renderer.removeInputHandler(this.rawListener)
  }

  public setData(name: string, value: unknown): void {
    this.assertNotDestroyed()

    if (value === undefined) {
      if (!(name in this.data)) {
        return
      }

      delete this.data[name]
      this.dataVersion += 1
      this.resolvePendingSequence()
      return
    }

    if (Object.is(this.data[name], value)) {
      return
    }

    this.data[name] = value
    this.dataVersion += 1
    this.resolvePendingSequence()
  }

  public getData(name: string): unknown {
    this.assertNotDestroyed()
    return this.data[name]
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    this.assertNotDestroyed()

    const pending = this.resolvePendingSequence()
    if (!pending) {
      return []
    }

    return this.collectSequenceStrokesFromNode(pending.node)
  }

  public getPendingSequenceParts(): readonly ParsedKeyPart[] {
    this.assertNotDestroyed()

    const pending = this.resolvePendingSequence()
    if (!pending) {
      return []
    }

    return this.collectSequencePartsFromNode(pending.node)
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
    const focused = this.getFocusedRenderable()
    const pending = this.resolvePendingSequence(focused)
    if (pending) {
      if (includeBindings) {
        return this.collectActiveKeysFromChildren(pending.node.children, true)
      }

      return this.collectActiveKeysFromChildrenFast(pending.node.children)
    }

    const activeLayers = this.getActiveLayers(focused)
    if (includeBindings) {
      return this.collectActiveKeysAtRoot(activeLayers, true)
    }

    return this.collectActiveKeysAtRootFast(activeLayers)
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

    const scope = this.normalizeScope(layer)
    const target = layer.target
    if (target && target.isDestroyed) {
      throw new Error("Cannot register a keymap layer for a destroyed renderable")
    }

    const registeredLayer: RegisteredLayer = {
      order: this.order++,
      target,
      scope,
      priority: layer.priority ?? 0,
      enabled: layer.enabled,
      root: this.compileBindings(layer.bindings),
    }

    this.layers.add(registeredLayer)
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

    return () => {
      this.unregisterLayer(registeredLayer)
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

    this.tokens.set(normalizedToken, registeredToken)

    return () => {
      const current = this.tokens.get(normalizedToken)
      if (current === registeredToken) {
        this.tokens.delete(normalizedToken)
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

    return () => {
      for (const command of normalizedCommands) {
        const current = this.commands.get(command.name)
        if (current === command) {
          if (command.attrs) {
            this.commandsWithAttrs -= 1
          }
          this.commands.delete(command.name)
        }
      }
    }
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("Keymap manager was already destroyed")
    }
  }

  private normalizeScope(layer: KeymapLayer): "global" | "focus" | "focus-within" {
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
    if (!this.layers.delete(layer)) {
      return
    }

    this.removeLayerFromIndex(layer)
    layer.offTargetDestroy?.()
    layer.offTargetDestroy = undefined

    if (this.pendingSequence?.layer === layer) {
      this.setPendingSequence(null)
    }
  }

  private compileBindings(bindings: KeymapBindings): SequenceNode {
    const root = createSequenceNode(null, null)

    for (const binding of normalizeBindingInputs(bindings)) {
      const sequence = parseKeySequenceLike(binding.key, this.tokens)
      const mergedRequires: KeymapEventData = {}
      const mergedAttrs: KeymapAttributes = {}

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
          },
          attr(name, attributeValue) {
            mergeAttribute(mergedAttrs, name, attributeValue, `field ${fieldName}`)
          },
        })
      }

      const attrs = freezeAttributes(mergedAttrs)
      const compiledBinding: CompiledBinding = {
        sequence,
        command: parseCommandInput(binding.cmd),
        requires: Object.entries(mergedRequires),
        consume: binding.consume !== false,
        fallthrough: binding.fallthrough ?? false,
      }

      if (attrs) {
        compiledBinding.attrs = attrs
      }

      this.insertBinding(root, compiledBinding)
    }

    return root
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
    for (const layer of activeLayers) {
      if (!resolveEnabled(layer.enabled)) {
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
      if (this.matchesBindingRequirements(binding)) {
        matches.push(binding)
      }
    }

    return matches
  }

  private hasMatchingBindings(bindings: readonly CompiledBinding[]): boolean {
    for (const binding of bindings) {
      if (this.matchesBindingRequirements(binding)) {
        return true
      }
    }

    return false
  }

  private getNodeDisplay(
    node: SequenceNode,
    reachableBindings = this.getMatchingBindings(node.reachableBindings),
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

    const command = this.resolveCommand(binding.command)
    if (command === binding.command) {
      return binding
    }

    return {
      sequence: binding.sequence,
      command,
      attrs: binding.attrs,
      consume: binding.consume,
      fallthrough: binding.fallthrough,
    }
  }

  private collectActiveBindings(bindings: readonly CompiledBinding[]): KeymapActiveBinding[] {
    return bindings.map((binding) => this.toActiveBinding(binding))
  }

  private collectResolvedCommands(
    bindings: readonly CompiledBinding[],
    resolveAttrs: boolean,
  ): KeymapResolvedCommand[] {
    const commands: KeymapResolvedCommand[] = []
    const seen = new Set<string>()

    if (!resolveAttrs || this.commandsWithAttrs === 0) {
      for (const binding of bindings) {
        if (seen.has(binding.command.input)) {
          continue
        }

        commands.push(binding.command)
        seen.add(binding.command.input)
      }

      return commands
    }

    for (const binding of bindings) {
      const command = this.resolveCommand(binding.command)
      if (seen.has(command.input)) {
        continue
      }

      commands.push(command)
      seen.add(command.input)
    }

    return commands
  }

  private collectCommandsFast(bindings: readonly CompiledBinding[]): KeymapResolvedCommand[] {
    const commands: KeymapResolvedCommand[] = []
    const seen = new Set<string>()

    for (const binding of bindings) {
      if (seen.has(binding.command.input)) {
        continue
      }

      commands.push(binding.command)
      seen.add(binding.command.input)
    }

    return commands
  }

  private createFastActiveKey(node: SequenceNode): KeymapActiveKey | undefined {
    if (!node.stroke) {
      return undefined
    }

    const partIndex = node.depth - 1
    if (node.reachableBindings.length === 1) {
      const [binding] = node.reachableBindings
      if (!binding || !this.matchesBindingRequirements(binding)) {
        return undefined
      }

      return {
        stroke: cloneStroke(node.stroke),
        display: binding.sequence[partIndex]?.display ?? stringifyKeyStroke(node.stroke),
        commands: [binding.command],
        continues: node.children.size > 0,
      }
    }

    const reachableBindings = this.getMatchingBindings(node.reachableBindings)
    if (reachableBindings.length === 0) {
      return undefined
    }

    const commands = this.collectCommandsFast(reachableBindings)
    if (commands.length === 0) {
      return undefined
    }

    return {
      stroke: cloneStroke(node.stroke),
      display: this.getNodeDisplay(node, reachableBindings),
      commands,
      continues: node.children.size > 0,
    }
  }

  private collectActiveKeysAtRootFast(activeLayers: RegisteredLayer[]): readonly KeymapActiveKey[] {
    const activeKeys = new Map<string, KeymapActiveKey>()

    for (const layer of activeLayers) {
      if (!resolveEnabled(layer.enabled)) {
        continue
      }

      for (const [bindingKey, child] of layer.root.children) {
        const activeKey = this.createFastActiveKey(child)
        if (!activeKey) {
          continue
        }

        const existing = activeKeys.get(bindingKey)
        if (!existing) {
          activeKeys.set(bindingKey, activeKey)
          continue
        }

        this.mergeActiveKeyFast(existing, activeKey.commands, activeKey.continues, activeKey.display)
      }
    }

    return [...activeKeys.values()]
  }

  private collectActiveKeysFromChildrenFast(children: ReadonlyMap<string, SequenceNode>): readonly KeymapActiveKey[] {
    const activeKeys: KeymapActiveKey[] = []

    for (const child of children.values()) {
      const activeKey = this.createFastActiveKey(child)
      if (!activeKey) {
        continue
      }

      activeKeys.push(activeKey)
    }

    return activeKeys
  }

  private mergeActiveKeyFast(
    activeKey: KeymapActiveKey,
    commands: KeymapResolvedCommand[],
    continues: boolean,
    display: string,
  ): void {
    for (const command of commands) {
      let exists = false
      for (const existing of activeKey.commands) {
        if (existing.input === command.input) {
          exists = true
          break
        }
      }

      if (exists) {
        continue
      }

      activeKey.commands.push(command)
    }

    if (continues) {
      activeKey.continues = true
    }

    if (activeKey.display !== display) {
      activeKey.display = stringifyKeyStroke(activeKey.stroke)
    }
  }

  private createActiveKey(node: SequenceNode, includeBindings: boolean): KeymapActiveKey | undefined {
    if (!node.stroke) {
      return undefined
    }

    const partIndex = node.depth - 1
    if (node.reachableBindings.length === 1) {
      const [binding] = node.reachableBindings
      if (!binding || !this.matchesBindingRequirements(binding)) {
        return undefined
      }

      const command =
        includeBindings && this.commandsWithAttrs > 0 ? this.resolveCommand(binding.command) : binding.command

      if (!includeBindings) {
        return {
          stroke: cloneStroke(node.stroke),
          display: binding.sequence[partIndex]?.display ?? stringifyKeyStroke(node.stroke),
          commands: [command],
          continues: node.children.size > 0,
        }
      }

      return {
        stroke: cloneStroke(node.stroke),
        display: binding.sequence[partIndex]?.display ?? stringifyKeyStroke(node.stroke),
        bindings: [this.toActiveBinding(binding)],
        commands: [command],
        continues: node.children.size > 0,
      }
    }

    const reachableBindings = this.getMatchingBindings(node.reachableBindings)
    if (reachableBindings.length === 0) {
      return undefined
    }

    const commands = this.collectResolvedCommands(reachableBindings, includeBindings)
    if (commands.length === 0) {
      return undefined
    }

    if (!includeBindings) {
      return {
        stroke: cloneStroke(node.stroke),
        display: this.getNodeDisplay(node, reachableBindings),
        commands,
        continues: node.children.size > 0,
      }
    }

    return {
      stroke: cloneStroke(node.stroke),
      display: this.getNodeDisplay(node, reachableBindings),
      bindings: this.collectActiveBindings(reachableBindings),
      commands,
      continues: node.children.size > 0,
    }
  }

  private collectActiveKeysAtRoot(
    activeLayers: RegisteredLayer[],
    includeBindings: boolean,
  ): readonly KeymapActiveKey[] {
    const activeKeys = new Map<string, KeymapActiveKey>()

    for (const layer of activeLayers) {
      if (!resolveEnabled(layer.enabled)) {
        continue
      }

      for (const [bindingKey, child] of layer.root.children) {
        const activeKey = this.createActiveKey(child, includeBindings)
        if (!activeKey) {
          continue
        }

        const existing = activeKeys.get(bindingKey)
        if (!existing) {
          activeKeys.set(bindingKey, activeKey)
          continue
        }

        this.mergeActiveKey(existing, activeKey, includeBindings)
      }
    }

    return [...activeKeys.values()]
  }

  private collectActiveKeysFromChildren(
    children: ReadonlyMap<string, SequenceNode>,
    includeBindings: boolean,
  ): readonly KeymapActiveKey[] {
    const activeKeys: KeymapActiveKey[] = []

    for (const child of children.values()) {
      const activeKey = this.createActiveKey(child, includeBindings)
      if (!activeKey) {
        continue
      }

      activeKeys.push(activeKey)
    }

    return activeKeys
  }

  private mergeActiveKey(activeKey: KeymapActiveKey, next: KeymapActiveKey, includeBindings: boolean): void {
    if (includeBindings) {
      if (!activeKey.bindings) {
        activeKey.bindings = []
      }

      if (next.bindings && next.bindings.length > 0) {
        activeKey.bindings.push(...next.bindings)
      }
    }

    for (const command of next.commands) {
      let exists = false
      for (const existing of activeKey.commands) {
        if (existing.input === command.input) {
          exists = true
          break
        }
      }

      if (exists) {
        continue
      }

      activeKey.commands.push(command)
    }

    if (next.continues) {
      activeKey.continues = true
    }

    if (activeKey.display !== next.display) {
      activeKey.display = stringifyKeyStroke(activeKey.stroke)
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
      if (!this.matchesBindingRequirements(binding)) {
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

  private matchesBindingRequirements(binding: CompiledBinding): boolean {
    if (binding.requires.length === 0) {
      return true
    }

    if (binding.matchCacheVersion === this.dataVersion) {
      return binding.matchCache === true
    }

    const matched = this.matchRequirements(binding.requires)
    binding.matchCacheVersion = this.dataVersion
    binding.matchCache = matched
    return matched
  }

  private setPendingSequence(next: PendingSequenceState | null): void {
    if (this.isSamePendingSequence(this.pendingSequence, next)) {
      return
    }

    this.pendingSequence = next
    this.notifyPendingSequenceChange()
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

    if (!resolveEnabled(this.pendingSequence.layer.enabled)) {
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
