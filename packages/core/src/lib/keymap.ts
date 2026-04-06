import type { Renderable } from "../Renderable.js"
import type { EditBufferRenderable } from "../renderables/EditBufferRenderable.js"
import type { KeyBinding as EditBufferKeyBinding, TextareaAction } from "../renderables/Textarea.js"
import type { CliRenderer } from "../renderer.js"
import type { KeyEvent } from "./KeyHandler.js"
import { defaultKeyAliases, getKeyBindingKey } from "./keymapping.js"

export type KeymapEnabled = boolean | (() => boolean)

export type KeymapEventData = Record<string, unknown>

export interface KeyStroke {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
}

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
  data?: KeymapEventData
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
  registerLayer(layer: KeymapLayer): () => void
  registerToken(token: KeymapToken): () => void
  registerBindingFields(fields: Record<string, KeymapBindingFieldCompiler>): () => void
  onKeyInput(
    fn: (ctx: KeymapKeyInputContext) => void,
    options?: { priority?: number; release?: boolean },
  ): () => void
  onRawInput(fn: (ctx: KeymapRawInputContext) => void, options?: { priority?: number }): () => void
  registerCommands(commands: KeymapCommand[]): () => void
}

interface ParsedKeyStroke {
  name: string
  ctrl: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

interface CompiledBinding {
  bindingKey: string
  command: KeymapResolvedCommand
  requires: KeymapEventData
  consume: boolean
  fallthrough: boolean
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

const RESERVED_BINDING_FIELDS = new Set(["key", "cmd", "consume", "fallthrough"])

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
  if (!next) {
    throw new Error('Invalid key name: key name cannot be empty')
  }

  next = next.toLowerCase()

  const seen = new Set<string>()
  while (defaultKeyAliases[next] && !seen.has(next)) {
    seen.add(next)
    next = defaultKeyAliases[next]!
  }

  return next
}

function buildBindingKey(stroke: ParsedKeyStroke): string {
  return getKeyBindingKey({ ...stroke, action: "" })
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

function parseKeyChord(input: string): ParsedKeyStroke {
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
      throw new Error(`Invalid key "${input}": multiple key names are not supported`)
    }

    name = normalizeKeyName(part)
  }

  if (!name) {
    throw new Error(`Invalid key "${input}": missing key name`)
  }

  return {
    name,
    ctrl,
    shift,
    meta,
    super: superKey,
  }
}

function normalizeKeyStroke(input: KeyStroke): ParsedKeyStroke {
  return {
    name: normalizeKeyName(input.name),
    ctrl: input.ctrl ?? false,
    shift: input.shift ?? false,
    meta: input.meta ?? false,
    super: input.super ?? false,
  }
}

function normalizeEventKeyStroke(event: KeyEvent): ParsedKeyStroke {
  return {
    name: normalizeKeyName(event.name),
    ctrl: event.ctrl,
    shift: event.shift,
    meta: event.meta,
    super: event.super ?? false,
  }
}

function mergeRequirement(target: KeymapEventData, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap requirement for "${name}" from ${source}`)
  }

  target[name] = value
}

function parseCommandInput(input: string): KeymapResolvedCommand {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error('Invalid keymap command: command cannot be empty')
  }

  const parts = trimmed.split(/\s+/)
  const [name, ...args] = parts
  if (!name) {
    throw new Error(`Invalid keymap command "${input}"`)
  }

  return {
    input: trimmed,
    name,
    args,
  }
}

function parseKeyLike(key: KeyLike, tokens: Map<string, RegisteredToken>): { stroke: ParsedKeyStroke; requires: KeymapEventData } {
  if (typeof key !== "string") {
    return {
      stroke: normalizeKeyStroke(key),
      requires: {},
    }
  }

  const parsed = parseLeadingTokens(key)
  const requires: KeymapEventData = {}

  for (const tokenName of parsed.tokens) {
    const token = tokens.get(tokenName)
    if (!token) {
      throw new Error(`Unknown keymap token "${tokenName}"`)
    }

    for (const [name, value] of Object.entries(token.data)) {
      mergeRequirement(requires, name, value, `token ${tokenName}`)
    }
  }

  return {
    stroke: parseKeyChord(parsed.rest),
    requires,
  }
}

function normalizeCommandName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Invalid keymap command name: name cannot be empty')
  }

  if (/\s/.test(trimmed)) {
    throw new Error(`Invalid keymap command name "${name}": command names cannot contain whitespace`)
  }

  return trimmed
}

function normalizeBindingInputs(bindings: KeymapBindings): KeymapBindingInput[] {
  if (Array.isArray(bindings)) {
    return bindings
  }

  const normalized: KeymapBindingInput[] = []
  for (const [key, cmd] of Object.entries(bindings)) {
    if (typeof cmd !== "string") {
      throw new Error(`Invalid keymap binding for "${key}": shorthand bindings must map to string commands`)
    }

    normalized.push({ key, cmd })
  }

  return normalized
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
  private bindingFields = new Map<string, KeymapBindingFieldCompiler>()
  private keyHooks: RegisteredKeyHook[] = []
  private rawHooks: RegisteredRawHook[] = []
  private commands = new Map<string, KeymapCommand>()
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
    this.bindingFields.clear()
    this.keyHooks = []
    this.rawHooks = []
    this.commands.clear()

    this.renderer.keyInput.off("keypress", this.keypressListener)
    this.renderer.keyInput.off("keyrelease", this.keyreleaseListener)
    this.renderer.removeInputHandler(this.rawListener)
  }

  public registerLayer(layer: KeymapLayer): () => void {
    this.assertNotDestroyed()

    const scope = this.normalizeScope(layer)
    const target = layer.target
    if (target && target.isDestroyed) {
      throw new Error('Cannot register a keymap layer for a destroyed renderable')
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
      throw new Error('Keymap manager was already destroyed')
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

  private compileBindings(bindings: KeymapBindings): Map<string, CompiledBinding[]> {
    const compiled = new Map<string, CompiledBinding[]>()

    for (const binding of normalizeBindingInputs(bindings)) {
      const { stroke, requires } = parseKeyLike(binding.key, this.tokens)
      const mergedRequires: KeymapEventData = { ...requires }

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

      const bindingKey = buildBindingKey(stroke)
      const nextBinding: CompiledBinding = {
        bindingKey,
        command: parseCommandInput(binding.cmd),
        requires: mergedRequires,
        consume: binding.consume !== false,
        fallthrough: binding.fallthrough ?? false,
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
    const bindingKey = buildBindingKey(normalizeEventKeyStroke(event))

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
        if (!this.matchRequirements(binding.requires, eventData)) {
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
      data: Object.freeze({ ...eventData }),
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

  private matchRequirements(requires: KeymapEventData, eventData: KeymapEventData): boolean {
    for (const [name, value] of Object.entries(requires)) {
      if (!Object.is(eventData[name], value)) {
        return false
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

export function useKeymappings(renderer: CliRenderer): KeymapManager {
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

export function useKeymap(manager: KeymapManager, layer: KeymapLayer): () => void {
  return manager.registerLayer(layer)
}

export function registerCommands(manager: KeymapManager, commands: KeymapCommand[]): () => void {
  return manager.registerCommands(commands)
}

export function registerActionCommands(manager: KeymapManager, commands: ActionCommand[]): () => void {
  return manager.registerCommands(commands)
}

function normalizeExCommandName(name: string): string {
  const normalized = normalizeCommandName(name)
  if (normalized.startsWith(":")) {
    return normalized
  }

  return `:${normalized}`
}

export function registerExCommands(manager: KeymapManager, commands: ExCommand[]): () => void {
  const registrations: KeymapCommand[] = []

  for (const command of commands) {
    const names = [command.name, ...(command.aliases ?? [])]
    for (const name of names) {
      const normalizedName = normalizeExCommandName(name)
      registrations.push({
        name: normalizedName,
        run(ctx) {
          if (!validateCommandArgs(command, ctx.command.args)) {
            return false
          }

          return command.run({
            ...ctx,
            raw: ctx.command.input,
            args: ctx.command.args,
          })
        },
      })
    }
  }

  return manager.registerCommands(registrations)
}

export const editBufferCommandNames = [
  "move-left",
  "move-right",
  "move-up",
  "move-down",
  "select-left",
  "select-right",
  "select-up",
  "select-down",
  "line-home",
  "line-end",
  "select-line-home",
  "select-line-end",
  "visual-line-home",
  "visual-line-end",
  "select-visual-line-home",
  "select-visual-line-end",
  "buffer-home",
  "buffer-end",
  "select-buffer-home",
  "select-buffer-end",
  "delete-line",
  "delete-to-line-end",
  "delete-to-line-start",
  "backspace",
  "delete",
  "newline",
  "undo",
  "redo",
  "word-forward",
  "word-backward",
  "select-word-forward",
  "select-word-backward",
  "delete-word-forward",
  "delete-word-backward",
  "select-all",
  "submit",
] as const satisfies readonly TextareaAction[]

export type EditBufferCommandName = (typeof editBufferCommandNames)[number]

const editBufferCommandNameSet = new Set<string>(editBufferCommandNames)

function withFocusedEditor(
  ctx: KeymapCommandContext,
  run: (editor: EditBufferRenderable) => boolean,
): boolean {
  const editor = ctx.renderer.currentFocusedEditor
  if (!editor || editor.isDestroyed) {
    return false
  }

  return run(editor)
}

function hasSubmit(editor: EditBufferRenderable): editor is EditBufferRenderable & { submit: () => boolean } {
  return typeof (editor as { submit?: unknown }).submit === "function"
}

function createEditBufferCommand(
  name: EditBufferCommandName,
  run: (editor: EditBufferRenderable) => boolean,
): KeymapCommand {
  return {
    name,
    run(ctx) {
      return withFocusedEditor(ctx, run)
    },
  }
}

export function registerEditBufferCommands(manager: KeymapManager): () => void {
  return manager.registerCommands([
    createEditBufferCommand("move-left", (editor) => editor.moveCursorLeft()),
    createEditBufferCommand("move-right", (editor) => editor.moveCursorRight()),
    createEditBufferCommand("move-up", (editor) => editor.moveCursorUp()),
    createEditBufferCommand("move-down", (editor) => editor.moveCursorDown()),
    createEditBufferCommand("select-left", (editor) => editor.moveCursorLeft({ select: true })),
    createEditBufferCommand("select-right", (editor) => editor.moveCursorRight({ select: true })),
    createEditBufferCommand("select-up", (editor) => editor.moveCursorUp({ select: true })),
    createEditBufferCommand("select-down", (editor) => editor.moveCursorDown({ select: true })),
    createEditBufferCommand("line-home", (editor) => editor.gotoLineHome()),
    createEditBufferCommand("line-end", (editor) => editor.gotoLineEnd()),
    createEditBufferCommand("select-line-home", (editor) => editor.gotoLineHome({ select: true })),
    createEditBufferCommand("select-line-end", (editor) => editor.gotoLineEnd({ select: true })),
    createEditBufferCommand("visual-line-home", (editor) => editor.gotoVisualLineHome()),
    createEditBufferCommand("visual-line-end", (editor) => editor.gotoVisualLineEnd()),
    createEditBufferCommand("select-visual-line-home", (editor) => editor.gotoVisualLineHome({ select: true })),
    createEditBufferCommand("select-visual-line-end", (editor) => editor.gotoVisualLineEnd({ select: true })),
    createEditBufferCommand("buffer-home", (editor) => editor.gotoBufferHome()),
    createEditBufferCommand("buffer-end", (editor) => editor.gotoBufferEnd()),
    createEditBufferCommand("select-buffer-home", (editor) => editor.gotoBufferHome({ select: true })),
    createEditBufferCommand("select-buffer-end", (editor) => editor.gotoBufferEnd({ select: true })),
    createEditBufferCommand("delete-line", (editor) => editor.deleteLine()),
    createEditBufferCommand("delete-to-line-end", (editor) => editor.deleteToLineEnd()),
    createEditBufferCommand("delete-to-line-start", (editor) => editor.deleteToLineStart()),
    createEditBufferCommand("backspace", (editor) => editor.deleteCharBackward()),
    createEditBufferCommand("delete", (editor) => editor.deleteChar()),
    createEditBufferCommand("newline", (editor) => editor.newLine()),
    createEditBufferCommand("undo", (editor) => editor.undo()),
    createEditBufferCommand("redo", (editor) => editor.redo()),
    createEditBufferCommand("word-forward", (editor) => editor.moveWordForward()),
    createEditBufferCommand("word-backward", (editor) => editor.moveWordBackward()),
    createEditBufferCommand("select-word-forward", (editor) => editor.moveWordForward({ select: true })),
    createEditBufferCommand("select-word-backward", (editor) => editor.moveWordBackward({ select: true })),
    createEditBufferCommand("delete-word-forward", (editor) => editor.deleteWordForward()),
    createEditBufferCommand("delete-word-backward", (editor) => editor.deleteWordBackward()),
    createEditBufferCommand("select-all", (editor) => editor.selectAll()),
    createEditBufferCommand("submit", (editor) => {
      if (!hasSubmit(editor)) {
        return false
      }

      return editor.submit()
    }),
  ])
}

export function compileEditBufferKeyBindings(bindings: KeymapBindings): EditBufferKeyBinding[] {
  return normalizeBindingInputs(bindings).map((binding) => {
    for (const [fieldName, value] of Object.entries(binding)) {
      if (RESERVED_BINDING_FIELDS.has(fieldName)) {
        continue
      }

      if (value === undefined) {
        continue
      }

      throw new Error(`Edit-buffer key bindings do not support the extra field "${fieldName}"`)
    }

    const { stroke, requires } = parseKeyLike(binding.key, new Map())
    if (Object.keys(requires).length > 0) {
      throw new Error('Edit-buffer key bindings do not support key tokens')
    }

    const command = parseCommandInput(binding.cmd)
    if (command.args.length > 0) {
      throw new Error(`Edit-buffer command "${binding.cmd}" cannot include arguments`)
    }

    if (!editBufferCommandNameSet.has(command.name)) {
      throw new Error(`Unknown edit-buffer command "${command.name}"`)
    }

    return {
      name: stroke.name,
      ctrl: stroke.ctrl || undefined,
      shift: stroke.shift || undefined,
      meta: stroke.meta || undefined,
      super: stroke.super || undefined,
      action: command.name as TextareaAction,
    }
  })
}
