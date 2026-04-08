import type { Renderable } from "../../Renderable.js"
import type { CliRenderer } from "../../renderer.js"
import type { KeyEvent } from "../../lib/KeyHandler.js"
import { getKeyBindingKey } from "../../lib/keymapping.js"
import {
  clonePart,
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
}

export type ActionCommand = KeymapCommand

export interface ExCommand {
  name: string
  aliases?: string[]
  nargs?: "0" | "1" | "?" | "*" | "+"
  run: (ctx: KeymapCommandContext & { raw: string; args: string[] }) => void | Promise<void>
}

export interface KeymapToken {
  token: string
  key: KeyLike
}

export interface KeymapActiveKey {
  stroke: ParsedKeyStroke
  display: string
  commands: KeymapResolvedCommand[]
  continues: boolean
}

export interface KeymapBindingFieldContext {
  require(name: string, value: unknown): void
}

export type KeymapBindingFieldCompiler = (value: unknown, ctx: KeymapBindingFieldContext) => void

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
  getActiveKeys(): readonly KeymapActiveKey[]
  onPendingSequenceChange(fn: (sequence: readonly ParsedKeyStroke[]) => void): () => void
  registerLayer(layer: KeymapLayer): () => void
  registerToken(token: KeymapToken): () => void
  registerBindingFields(fields: Record<string, KeymapBindingFieldCompiler>): () => void
  onKeyInput(fn: (ctx: KeymapKeyInputContext) => void, options?: { priority?: number; release?: boolean }): () => void
  onRawInput(fn: (ctx: KeymapRawInputContext) => void, options?: { priority?: number }): () => void
  registerCommands(commands: KeymapCommand[]): () => void
}

interface CompiledBinding {
  sequence: ParsedKeyPart[]
  command: KeymapResolvedCommand
  requires: KeymapEventData
  consume: boolean
  fallthrough: boolean
}

interface SequenceNode {
  parent: SequenceNode | null
  depth: number
  stroke: ParsedKeyStroke | null
  bindingKey: string | null
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
}

interface RegisteredToken {
  token: string
  stroke: ParsedKeyStroke
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
  return getKeyBindingKey({ ...stroke, action: "" })
}

function createSequenceNode(parent: SequenceNode | null, stroke: ParsedKeyStroke | null): SequenceNode {
  return {
    parent,
    depth: parent ? parent.depth + 1 : 0,
    stroke,
    bindingKey: stroke ? buildBindingKey(stroke) : null,
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

class KeymapManagerImpl implements KeymapManager {
  public readonly renderer: CliRenderer

  private layers: RegisteredLayer[] = []
  private tokens = new Map<string, RegisteredToken>()
  private bindingFields = new Map<string, KeymapBindingFieldCompiler>()
  private keyHooks: RegisteredKeyHook[] = []
  private rawHooks: RegisteredRawHook[] = []
  private pendingSequenceListeners: Array<(sequence: readonly ParsedKeyStroke[]) => void> = []
  private commands = new Map<string, KeymapCommand>()
  private data: KeymapEventData = {}
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
    this.destroyed = true
    this.layers = []
    this.tokens.clear()
    this.bindingFields.clear()
    this.keyHooks = []
    this.rawHooks = []
    this.pendingSequenceListeners = []
    this.commands.clear()
    this.data = {}

    this.renderer.keyInput.off("keypress", this.keypressListener)
    this.renderer.keyInput.off("keyrelease", this.keyreleaseListener)
    this.renderer.removeInputHandler(this.rawListener)
  }

  public setData(name: string, value: unknown): void {
    this.assertNotDestroyed()

    if (value === undefined) {
      delete this.data[name]
      this.resolvePendingSequence()
      return
    }

    this.data[name] = value
    this.resolvePendingSequence()
  }

  public getData(name: string): unknown {
    this.assertNotDestroyed()
    return this.data[name]
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    return this.getPendingSequenceParts().map((part) => cloneStroke(part.stroke))
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

  public getActiveKeys(): readonly KeymapActiveKey[] {
    this.assertNotDestroyed()

    this.pruneDestroyedLayers()

    const focused = this.getFocusedRenderable()
    const activeLayers = this.getActiveLayers(focused)
    const pending = this.resolvePendingSequence(activeLayers)
    if (pending) {
      return this.collectActiveKeysFromChildren(pending.node.children)
    }

    return this.collectActiveKeysAtRoot(activeLayers)
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

    this.layers = [...this.layers, registeredLayer]

    return () => {
      this.layers = this.layers.filter((candidate) => candidate !== registeredLayer)
      if (this.pendingSequence?.layer === registeredLayer) {
        this.setPendingSequence(null)
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

    const registeredToken: RegisteredToken = {
      token: normalizedToken,
      stroke: parseKeyLike(token.key),
    }

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
      return {
        name: normalizeCommandName(command.name),
        run: command.run,
      } satisfies KeymapCommand
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

    return () => {
      for (const command of normalizedCommands) {
        const current = this.commands.get(command.name)
        if (current === command) {
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

  private compileBindings(bindings: KeymapBindings): SequenceNode {
    const root = createSequenceNode(null, null)

    for (const binding of normalizeBindingInputs(bindings)) {
      const sequence = parseKeySequenceLike(binding.key, this.tokens)
      const mergedRequires: KeymapEventData = {}

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
        })
      }

      const compiledBinding: CompiledBinding = {
        sequence: sequence.map(clonePart),
        command: parseCommandInput(binding.cmd),
        requires: mergedRequires,
        consume: binding.consume !== false,
        fallthrough: binding.fallthrough ?? false,
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

    const hooks = [...this.keyHooks]
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
    this.pruneDestroyedLayers()

    const focused = this.getFocusedRenderable()
    const activeLayers = this.getActiveLayers(focused)
    const pending = this.resolvePendingSequence(activeLayers)
    const stroke = normalizeEventKeyStroke(event)

    if (pending) {
      this.dispatchPendingSequence(pending, stroke, event, focused)
      return
    }

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
    for (const binding of node.reachableBindings) {
      if (this.matchRequirements(binding.requires)) {
        return true
      }
    }

    return false
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

  private getNodeDisplay(node: SequenceNode): string {
    if (!node.stroke) {
      return ""
    }

    const partIndex = node.depth - 1
    let display: string | undefined

    for (const binding of node.reachableBindings) {
      if (!this.matchRequirements(binding.requires)) {
        continue
      }

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

  private collectActiveKeysAtRoot(activeLayers: RegisteredLayer[]): readonly KeymapActiveKey[] {
    const activeKeys = new Map<string, KeymapActiveKey>()

    for (const layer of activeLayers) {
      if (!resolveEnabled(layer.enabled)) {
        continue
      }

      for (const [bindingKey, child] of layer.root.children) {
        if (!child.stroke || !this.nodeHasReachableBindings(child)) {
          continue
        }

        const commands = this.collectReachableCommands(child)
        if (commands.length === 0) {
          continue
        }

        const existing = activeKeys.get(bindingKey)
        if (!existing) {
          activeKeys.set(bindingKey, {
            stroke: cloneStroke(child.stroke),
            display: this.getNodeDisplay(child),
            commands: [...commands],
            continues: child.children.size > 0,
          })
          continue
        }

        this.mergeActiveKey(existing, commands, child.children.size > 0, this.getNodeDisplay(child))
      }
    }

    return [...activeKeys.values()]
  }

  private collectActiveKeysFromChildren(children: ReadonlyMap<string, SequenceNode>): readonly KeymapActiveKey[] {
    const activeKeys: KeymapActiveKey[] = []

    for (const child of children.values()) {
      if (!child.stroke || !this.nodeHasReachableBindings(child)) {
        continue
      }

      const commands = this.collectReachableCommands(child)
      if (commands.length === 0) {
        continue
      }

      activeKeys.push({
        stroke: cloneStroke(child.stroke),
        display: this.getNodeDisplay(child),
        commands,
        continues: child.children.size > 0,
      })
    }

    return activeKeys
  }

  private collectReachableCommands(node: SequenceNode): KeymapResolvedCommand[] {
    const commands: KeymapResolvedCommand[] = []
    const seen = new Set<string>()

    for (const binding of node.reachableBindings) {
      if (!this.matchRequirements(binding.requires)) {
        continue
      }

      if (seen.has(binding.command.input)) {
        continue
      }

      commands.push(binding.command)
      seen.add(binding.command.input)
    }

    return commands
  }

  private mergeActiveKey(
    activeKey: KeymapActiveKey,
    commands: KeymapResolvedCommand[],
    continues: boolean,
    display: string,
  ): void {
    const seen = new Set(activeKey.commands.map((command) => command.input))
    for (const command of commands) {
      if (seen.has(command.input)) {
        continue
      }

      activeKey.commands.push(command)
      seen.add(command.input)
    }

    if (continues) {
      activeKey.continues = true
    }

    if (activeKey.display !== display) {
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
      if (!this.matchRequirements(binding.requires)) {
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
    const command = this.commands.get(binding.command.name)
    if (!command) {
      return false
    }

    const context: KeymapCommandContext = {
      manager: this,
      renderer: this.renderer,
      event,
      focused,
      target: layer.target ?? null,
      data: Object.freeze({ ...this.data }),
      command: binding.command,
    }

    let result: KeymapCommandResult
    try {
      result = command.run(context)
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

  private matchRequirements(requires: KeymapEventData): boolean {
    for (const [name, value] of Object.entries(requires)) {
      if (!Object.is(this.data[name], value)) {
        return false
      }
    }

    return true
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

    const sequence = this.pendingSequence
      ? this.collectSequencePartsFromNode(this.pendingSequence.node).map((part) => cloneStroke(part.stroke))
      : []
    const listeners = [...this.pendingSequenceListeners]
    for (const listener of listeners) {
      try {
        listener(sequence)
      } catch (error) {
        console.error("[Keymap] Error in pending sequence hook:", error)
      }
    }
  }

  private pruneDestroyedLayers(): void {
    const nextLayers = this.layers.filter((layer) => {
      if (!layer.target) {
        return true
      }

      return !layer.target.isDestroyed
    })

    if (nextLayers.length !== this.layers.length) {
      this.layers = nextLayers
      if (this.pendingSequence && !this.layers.includes(this.pendingSequence.layer)) {
        this.setPendingSequence(null)
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
      while (current) {
        const localLayers = this.layers.filter((layer) => {
          if (!layer.target || layer.target !== current) {
            return false
          }

          if (layer.scope === "focus") {
            return current === focused
          }

          return layer.scope === "focus-within"
        })

        activeLayers.push(...sortLayersWithinScope(localLayers))
        current = current.parent
      }
    }

    const globalLayers = this.layers.filter((layer) => layer.scope === "global")
    activeLayers.push(...sortLayersWithinScope(globalLayers))

    return activeLayers
  }

  private resolvePendingSequence(activeLayers?: RegisteredLayer[]): PendingSequenceState | undefined {
    if (!this.pendingSequence) {
      return undefined
    }

    const layers = activeLayers ?? this.getActiveLayers(this.getFocusedRenderable())
    if (!layers.includes(this.pendingSequence.layer)) {
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
