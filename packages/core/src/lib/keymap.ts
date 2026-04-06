import type { Renderable } from "../Renderable.js"
import type { CliRenderer } from "../renderer.js"
import { defaultKeyAliases, getKeyBindingKey } from "./keymapping.js"
import type { KeyEvent } from "./KeyHandler.js"

export type KeymapEnabled = boolean | (() => boolean)

export type KeymapEventData = Record<string, unknown>

export type KeymapCommandFunction = (ctx: KeymapCommandContext) => void | Promise<void>

export interface KeymapCommandDescriptor {
  kind: string
  value: unknown
}

export interface KeymapBindingOptions {
  command: string | KeymapCommandFunction | KeymapCommandDescriptor
  fallthrough?: boolean
  preventDefault?: boolean
  stopPropagation?: boolean
  enabled?: KeymapEnabled
}

export type KeymapBindingValue = string | KeymapCommandFunction | KeymapBindingOptions

export interface KeymapLayer {
  target?: Renderable
  scope?: "global" | "focus" | "focus-within"
  priority?: number
  enabled?: KeymapEnabled
  bindings: Record<string, KeymapBindingValue>
}

export interface KeymapCommandContext {
  manager: KeymapManager
  renderer: CliRenderer
  event: KeyEvent
  focused: Renderable | null
  target: Renderable | null
  data: Readonly<KeymapEventData>
}

export type KeymapCommandResult = boolean | void | Promise<boolean | void>

export type KeymapCommandRunner = (value: unknown, ctx: KeymapCommandContext) => KeymapCommandResult

export interface KeymapToken {
  token: string
  data?: KeymapEventData
}

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
  registerLayer(layer: KeymapLayer): () => void
  registerToken(token: KeymapToken): () => void
  onKeyInput(
    fn: (ctx: KeymapKeyInputContext) => void,
    options?: { priority?: number; release?: boolean },
  ): () => void
  onRawInput(fn: (ctx: KeymapRawInputContext) => void, options?: { priority?: number }): () => void
  registerCommandKind(kind: string, runner: KeymapCommandRunner): () => void
}

export interface ActionCommand {
  name: string
  run: KeymapCommandFunction
}

export interface ExCommand {
  name: string
  aliases?: string[]
  nargs?: "0" | "1" | "?" | "*" | "+"
  run: (ctx: KeymapCommandContext & { raw: string; args: string[] }) => void | Promise<void>
}

interface ParsedKeyChord {
  name: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

interface CompiledBinding {
  bindingKey: string
  rawKey: string
  tokens: string[]
  command: KeymapCommandDescriptor
  fallthrough: boolean
  preventDefault: boolean
  stopPropagation: boolean
  enabled?: KeymapEnabled
}

interface RegisteredLayer {
  order: number
  target?: Renderable
  scope: "global" | "focus" | "focus-within"
  priority: number
  enabled?: KeymapEnabled
  compiledBindings: Map<string, CompiledBinding[]>
}

interface RegisteredToken {
  token: string
  data: KeymapEventData
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

const keymapManagersByRenderer = new WeakMap<CliRenderer, KeymapManagerImpl>()

const installedDefaultExtensions = new WeakSet<KeymapManager>()
const actionExtensionState = new WeakMap<KeymapManager, { commands: Map<string, ActionCommand> }>()
const exExtensionState = new WeakMap<KeymapManager, { commands: Map<string, ExCommand> }>()

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

function normalizeTokenName(token: string): string {
  return token.trim().toLowerCase()
}

function normalizeKeyName(name: string): string {
  if (name === " ") {
    return "space"
  }

  let next = name.trim()
  if (next.length === 1) {
    next = next.toLowerCase()
  } else {
    next = next.toLowerCase()
  }

  const seen = new Set<string>()
  while (defaultKeyAliases[next] && !seen.has(next)) {
    seen.add(next)
    next = defaultKeyAliases[next]!
  }

  return next
}

function toBindingKey(chord: ParsedKeyChord): string {
  return getKeyBindingKey({ ...chord, action: "" })
}

function parseLeadingTokens(input: string): { tokens: string[]; rest: string } {
  const tokens: string[] = []
  let rest = input

  while (rest.startsWith("<")) {
    const end = rest.indexOf(">")
    if (end === -1) {
      break
    }

    const token = rest.slice(0, end + 1)
    tokens.push(normalizeTokenName(token))
    rest = rest.slice(end + 1).trimStart()
  }

  return { tokens, rest }
}

function parseKeyChord(input: string): ParsedKeyChord {
  if (input === " ") {
    return { name: "space", ctrl: false, shift: false, meta: false, super: false }
  }

  if (input === "+") {
    return { name: "+", ctrl: false, shift: false, meta: false, super: false }
  }

  const parts = input.split("+")
  let name = ""
  let ctrl = false
  let shift = false
  let meta = false
  let superKey = false

  for (const rawPart of parts) {
    const part = rawPart.trim()
    if (!part) {
      continue
    }

    const lowered = part.toLowerCase()
    if (lowered === "ctrl" || lowered === "control") {
      ctrl = true
      continue
    }

    if (lowered === "shift") {
      shift = true
      continue
    }

    if (lowered === "meta" || lowered === "alt" || lowered === "option") {
      meta = true
      continue
    }

    if (lowered === "super") {
      superKey = true
      continue
    }

    if (name) {
      throw new Error(`Invalid key binding "${input}": multiple key names are not supported`)
    }

    name = normalizeKeyName(part)
  }

  if (!name) {
    throw new Error(`Invalid key binding "${input}": missing key name`)
  }

  return {
    name,
    ctrl,
    shift,
    meta,
    super: superKey,
  }
}

function normalizeEventChord(event: KeyEvent): ParsedKeyChord {
  return {
    name: normalizeKeyName(event.name),
    ctrl: event.ctrl,
    shift: event.shift,
    meta: event.meta,
    super: event.super ?? false,
  }
}

function normalizeCommandDescriptor(input: string | KeymapCommandFunction | KeymapCommandDescriptor): KeymapCommandDescriptor {
  if (typeof input === "function") {
    return { kind: "action", value: input }
  }

  if (typeof input === "string") {
    if (input.startsWith(":")) {
      return { kind: "ex", value: input }
    }

    return { kind: "action", value: input }
  }

  return input
}

function normalizeBindingValue(input: KeymapBindingValue): Omit<CompiledBinding, "bindingKey" | "rawKey" | "tokens"> {
  if (typeof input === "string" || typeof input === "function") {
    return {
      command: normalizeCommandDescriptor(input),
      fallthrough: false,
      preventDefault: true,
      stopPropagation: true,
    }
  }

  return {
    command: normalizeCommandDescriptor(input.command),
    fallthrough: input.fallthrough ?? false,
    preventDefault: input.preventDefault ?? true,
    stopPropagation: input.stopPropagation ?? true,
    enabled: input.enabled,
  }
}

function validateCommandArgs(command: ExCommand, args: string[]): boolean {
  if (!command.nargs) {
    return true
  }

  const count = args.length
  if (command.nargs === "0") {
    return count === 0
  }

  if (command.nargs === "1") {
    return count === 1
  }

  if (command.nargs === "?") {
    return count <= 1
  }

  if (command.nargs === "*") {
    return true
  }

  if (command.nargs === "+") {
    return count >= 1
  }

  return true
}

class KeymapManagerImpl implements KeymapManager {
  public readonly renderer: CliRenderer

  private layers: RegisteredLayer[] = []
  private tokens = new Map<string, RegisteredToken>()
  private keyHooks: RegisteredKeyHook[] = []
  private rawHooks: RegisteredRawHook[] = []
  private commandKinds = new Map<string, KeymapCommandRunner>()
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

    this.destroyed = true
    this.layers = []
    this.tokens.clear()
    this.keyHooks = []
    this.rawHooks = []
    this.commandKinds.clear()

    this.renderer.keyInput.off("keypress", this.keypressListener)
    this.renderer.keyInput.off("keyrelease", this.keyreleaseListener)
    this.renderer.removeInputHandler(this.rawListener)
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
      compiledBindings: this.compileBindings(layer.bindings),
    }

    this.layers = [...this.layers, registeredLayer]

    return () => {
      this.layers = this.layers.filter((candidate) => candidate !== registeredLayer)
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
      data: { ...(token.data ?? {}) },
    }

    this.tokens.set(normalizedToken, registeredToken)

    return () => {
      this.tokens.delete(normalizedToken)
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

  public registerCommandKind(kind: string, runner: KeymapCommandRunner): () => void {
    this.assertNotDestroyed()

    if (this.commandKinds.has(kind)) {
      throw new Error(`Keymap command kind "${kind}" is already registered`)
    }

    this.commandKinds.set(kind, runner)

    return () => {
      const current = this.commandKinds.get(kind)
      if (current === runner) {
        this.commandKinds.delete(kind)
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

  private compileBindings(bindings: Record<string, KeymapBindingValue>): Map<string, CompiledBinding[]> {
    const compiled = new Map<string, CompiledBinding[]>()

    for (const [rawKey, rawBinding] of Object.entries(bindings)) {
      const parsed = parseLeadingTokens(rawKey.trimStart())
      const chord = parseKeyChord(parsed.rest)
      const bindingKey = toBindingKey(chord)
      const normalized = normalizeBindingValue(rawBinding)

      const nextBinding: CompiledBinding = {
        ...normalized,
        bindingKey,
        rawKey,
        tokens: parsed.tokens,
      }

      const existing = compiled.get(bindingKey) ?? []
      compiled.set(bindingKey, [...existing, nextBinding])
    }

    return compiled
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

    const eventData: KeymapEventData = {}
    const hooks = [...this.keyHooks]
    const context: KeymapKeyInputContext = {
      event,
      setData(name, value) {
        if (value === undefined) {
          delete eventData[name]
          return
        }

        eventData[name] = value
      },
      getData(name) {
        return eventData[name]
      },
      consume(options) {
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

    this.dispatchLayers(event, eventData)
  }

  private dispatchLayers(event: KeyEvent, eventData: KeymapEventData): void {
    const bindingKey = toBindingKey(normalizeEventChord(event))
    if (!bindingKey) {
      return
    }

    this.pruneDestroyedLayers()

    const focused = this.getFocusedRenderable()
    const activeLayers = this.getActiveLayers(focused)
    for (const layer of activeLayers) {
      if (!resolveEnabled(layer.enabled)) {
        continue
      }

      const candidates = layer.compiledBindings.get(bindingKey)
      if (!candidates || candidates.length === 0) {
        continue
      }

      for (const binding of candidates) {
        if (!resolveEnabled(binding.enabled)) {
          continue
        }

        if (!this.matchBindingTokens(binding.tokens, eventData)) {
          continue
        }

        const handled = this.runBinding(layer, binding, event, eventData, focused)
        if (!handled) {
          continue
        }

        if (!binding.fallthrough) {
          return
        }
      }
    }
  }

  private runBinding(
    layer: RegisteredLayer,
    binding: CompiledBinding,
    event: KeyEvent,
    eventData: KeymapEventData,
    focused: Renderable | null,
  ): boolean {
    const runner = this.commandKinds.get(binding.command.kind)
    if (!runner) {
      return false
    }

    const frozenData = Object.freeze({ ...eventData })
    const context: KeymapCommandContext = {
      manager: this,
      renderer: this.renderer,
      event,
      focused,
      target: layer.target ?? null,
      data: frozenData,
    }

    let result: KeymapCommandResult
    try {
      result = runner(binding.command.value, context)
    } catch (error) {
      console.error(`[Keymap] Error running command kind "${binding.command.kind}":`, error)
      this.applyBindingEventEffects(binding, event)
      return true
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        console.error(`[Keymap] Async error in command kind "${binding.command.kind}":`, error)
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
    if (binding.preventDefault) {
      event.preventDefault()
    }

    if (binding.stopPropagation) {
      event.stopPropagation()
    }
  }

  private matchBindingTokens(tokens: string[], eventData: KeymapEventData): boolean {
    for (const tokenName of tokens) {
      const token = this.tokens.get(tokenName)
      if (!token) {
        return false
      }

      for (const [key, value] of Object.entries(token.data)) {
        if (eventData[key] !== value) {
          return false
        }
      }
    }

    return true
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
}

function ensureActionExtension(manager: KeymapManager): void {
  if (actionExtensionState.has(manager)) {
    return
  }

  const commands = new Map<string, ActionCommand>()
  manager.registerCommandKind("action", (value, ctx) => {
    if (typeof value === "function") {
      const result = value(ctx)
      if (isPromiseLike(result)) {
        result.catch((error) => {
          console.error("[Keymap] Async error in inline action command:", error)
        })
      }
      return true
    }

    if (typeof value !== "string") {
      return false
    }

    const command = commands.get(value)
    if (!command) {
      return false
    }

    const result = command.run(ctx)
    if (isPromiseLike(result)) {
      result.catch((error) => {
        console.error(`[Keymap] Async error in action command "${command.name}":`, error)
      })
    }

    return true
  })

  actionExtensionState.set(manager, { commands })
}

function ensureExExtension(manager: KeymapManager): void {
  if (exExtensionState.has(manager)) {
    return
  }

  const commands = new Map<string, ExCommand>()
  manager.registerCommandKind("ex", (value, ctx) => {
    if (typeof value !== "string") {
      return false
    }

    const raw = value.startsWith(":") ? value.slice(1).trim() : value.trim()
    if (!raw) {
      return false
    }

    const [name, ...args] = raw.split(/\s+/)
    if (!name) {
      return false
    }

    const command = commands.get(name)
    if (!command) {
      return false
    }

    if (!validateCommandArgs(command, args)) {
      return false
    }

    const result = command.run({ ...ctx, raw, args })
    if (isPromiseLike(result)) {
      result.catch((error) => {
        console.error(`[Keymap] Async error in ex command "${command.name}":`, error)
      })
    }

    return true
  })

  exExtensionState.set(manager, { commands })
}

function installDefaultExtensions(manager: KeymapManager): void {
  if (installedDefaultExtensions.has(manager)) {
    return
  }

  ensureActionExtension(manager)
  ensureExExtension(manager)
  installedDefaultExtensions.add(manager)
}

export function useKeymappings(renderer: CliRenderer): KeymapManager {
  const existing = keymapManagersByRenderer.get(renderer)
  if (existing) {
    if (existing.isDestroyed) {
      keymapManagersByRenderer.delete(renderer)
    } else {
      installDefaultExtensions(existing)
      return existing
    }
  }

  const manager = new KeymapManagerImpl(renderer)
  installDefaultExtensions(manager)
  keymapManagersByRenderer.set(renderer, manager)

  renderer.once("destroy", () => {
    manager.destroy()
    keymapManagersByRenderer.delete(renderer)
  })

  return manager
}

export function useKeymap(manager: KeymapManager, layer: KeymapLayer): () => void {
  return manager.registerLayer(layer)
}

export function registerActionCommands(manager: KeymapManager, commands: ActionCommand[]): () => void {
  ensureActionExtension(manager)
  const state = actionExtensionState.get(manager)
  if (!state) {
    throw new Error("Action command extension was not installed")
  }

  const previousEntries = new Map<string, ActionCommand | undefined>()
  for (const command of commands) {
    previousEntries.set(command.name, state.commands.get(command.name))
    state.commands.set(command.name, command)
  }

  return () => {
    for (const command of commands) {
      const previous = previousEntries.get(command.name)
      if (previous) {
        state.commands.set(command.name, previous)
        continue
      }

      state.commands.delete(command.name)
    }
  }
}

export function registerExCommands(manager: KeymapManager, commands: ExCommand[]): () => void {
  ensureExExtension(manager)
  const state = exExtensionState.get(manager)
  if (!state) {
    throw new Error("Ex command extension was not installed")
  }

  const previousEntries = new Map<string, ExCommand | undefined>()
  const keysByCommand = new Map<ExCommand, string[]>()

  for (const command of commands) {
    const keys = [command.name, ...(command.aliases ?? [])]
    keysByCommand.set(command, keys)
    for (const key of keys) {
      previousEntries.set(key, state.commands.get(key))
      state.commands.set(key, command)
    }
  }

  return () => {
    for (const command of commands) {
      const keys = keysByCommand.get(command) ?? []
      for (const key of keys) {
        const previous = previousEntries.get(key)
        if (previous) {
          state.commands.set(key, previous)
          continue
        }

        state.commands.delete(key)
      }
    }
  }
}
