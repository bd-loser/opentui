import type { Renderable } from "../../Renderable.js"
import { CliRenderEvents, type CliRenderer } from "../../renderer.js"
import { KeyEvent } from "../../lib/KeyHandler.js"
import type {
  ActionMapActiveKey,
  ActionMapActiveKeyOptions,
  ActionMapBindingCompiler,
  ActionMapBindingExpander,
  ActionMapBindingParser,
  ActionMapBindingSyntax,
  ActionMapBindingFieldCompiler,
  ActionMapHookListener,
  ActionMapHooks,
  ActionMapEvents,
  ActionMapCommandDefinition,
  ActionMapCommandFieldCompiler,
  ActionMapCommandQuery,
  ActionMapCommandRecord,
  ActionMapRunCommandOptions,
  ActionMapRunCommandResult,
  ActionMapCommandResolver,
  ActionMapKeyInputContext,
  ActionMapLayer,
  ActionMapLayerFieldCompiler,
  ActionMapRawInputContext,
  ActionMapEventMatchResolver,
  ActionMapStringifiableKey,
  ActionMapToken,
  KeyLike,
  ParsedKeyPart,
  ParsedKeyToken,
  ParsedKeyStroke,
  PendingSequenceState,
} from "./types.js"
import { buildBindingKey, getErrorMessage } from "./lib/utils.js"
import { ActionMapCommands } from "./action-map-commands.js"
import { ActionMapCompiler, RESERVED_BINDING_FIELDS } from "./action-map-compiler.js"
import { ActionMapConditions } from "./action-map-conditions.js"
import { ActionMapDispatch } from "./action-map-dispatch.js"
import { ActionMapLayers, RESERVED_LAYER_FIELDS } from "./action-map-layers.js"
import { defaultBindingParser, defaultBindingSyntax, defaultEventMatchResolver } from "./lib/default-parser.js"
import { Emitter, type EmitterListener } from "./lib/emitter.js"
import { ActionMapNotifier } from "./action-map-notify.js"
import { ActionMapRuntime } from "./action-map-runtime.js"
import { createActionMapState, resetActionMapState } from "./action-map-state.js"
import { RESERVED_COMMAND_FIELDS } from "./action-map-commands.js"

const actionMapsByRenderer = new WeakMap<CliRenderer, ActionMap>()
const NOOP = (): void => {}

type ActionMapFieldKind = "layer" | "binding" | "command"

function getKeyMatchKey(input: ActionMapStringifiableKey): string {
  if ("matchKey" in input) {
    return input.matchKey
  }

  if ("stroke" in input) {
    return buildBindingKey(input.stroke)
  }

  return buildBindingKey(input)
}

function registerFieldCompilers<T>(
  fields: Record<string, T>,
  options: {
    kind: ActionMapFieldKind
    reservedFields: ReadonlySet<string>
    registeredFields: Map<string, T>
    emitError(message: string): void
  },
): () => void {
  const { kind, reservedFields, registeredFields, emitError } = options
  const entries = Object.entries(fields)
  const registered: Array<[string, T]> = []

  for (const [name] of entries) {
    if (reservedFields.has(name)) {
      emitError(`ActionMap ${kind} field "${name}" is reserved`)
      continue
    }

    if (registeredFields.has(name)) {
      emitError(`ActionMap ${kind} field "${name}" is already registered`)
    }
  }

  for (const [name, compiler] of entries) {
    if (reservedFields.has(name) || registeredFields.has(name)) {
      continue
    }

    registeredFields.set(name, compiler)
    registered.push([name, compiler])
  }

  return () => {
    for (const [name, compiler] of registered) {
      const current = registeredFields.get(name)
      if (current === compiler) {
        registeredFields.delete(name)
      }
    }
  }
}

export class ActionMap {
  public readonly renderer: CliRenderer

  private readonly state = createActionMapState()
  // Reuse `Emitter`, but keep its `onError` hook as a no-op so throwing error
  // listeners cannot re-enter `emitError` and loop forever.
  private events = new Emitter<ActionMapEvents>(() => {})
  private hooks: Emitter<ActionMapHooks>
  private readonly notify: ActionMapNotifier
  private readonly runtime: ActionMapRuntime
  private readonly conditions: ActionMapConditions
  private readonly commands: ActionMapCommands
  private readonly compiler: ActionMapCompiler
  private readonly dispatch: ActionMapDispatch
  private readonly layers: ActionMapLayers

  private readonly keypressListener: (event: KeyEvent) => void
  private readonly keyreleaseListener: (event: KeyEvent) => void
  private readonly rawListener: (sequence: string) => boolean
  private readonly focusedRenderableListener: (focused: Renderable | null) => void

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.hooks = new Emitter<ActionMapHooks>((name, error) => {
      this.notify.reportHookError(name, error)
    })
    this.notify = new ActionMapNotifier(this.state, this.events, this.hooks)
    this.conditions = new ActionMapConditions(this.state, this.notify)
    this.runtime = new ActionMapRuntime(this.state, this.renderer, this.hooks, this.notify, this.conditions)
    this.commands = new ActionMapCommands(this.state, this.notify, this.runtime, this.hooks, {
      actionMap: this,
    })
    this.compiler = new ActionMapCompiler(this.state, this.notify, this.commands, this.conditions, {
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
      warnUnknownToken: (token, sequence) => {
        this.warnUnknownToken(token, sequence)
      },
    })
    this.layers = new ActionMapLayers(this.state, this.notify, this.conditions, this.runtime, {
      compiler: this.compiler,
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
    })
    this.dispatch = new ActionMapDispatch(this.state, this.notify, this.runtime, this.conditions, this.commands)
    this.state.config.bindingSyntax = defaultBindingSyntax
    this.state.config.bindingParsers.append(defaultBindingParser)
    this.state.config.eventMatchResolvers.append(defaultEventMatchResolver)
    this.keypressListener = (event) => {
      this.dispatch.handleKeyEvent(event, false)
    }
    this.keyreleaseListener = (event) => {
      this.dispatch.handleKeyEvent(event, true)
    }
    this.rawListener = (sequence) => {
      return this.dispatch.handleRawSequence(sequence)
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
    return this.state.core.destroyed
  }

  public destroy(): void {
    if (this.state.core.destroyed) {
      return
    }

    this.setPendingSequence(null)

    for (const layer of this.state.layers.layers) {
      // Drop matcher subscriptions before clearing layer state.
      this.conditions.unregisterRuntimeMatchable(layer)
      for (const binding of layer.compiledBindings) {
        this.conditions.unregisterRuntimeMatchable(binding)
      }

      layer.offTargetDestroy?.()
      layer.offTargetDestroy = undefined
      layer.bucket = undefined
    }

    this.hooks.clear()
    resetActionMapState(this.state, { destroyed: true })
    this.events.clear()

    this.renderer.keyInput.off("keypress", this.keypressListener)
    this.renderer.keyInput.off("keyrelease", this.keyreleaseListener)
    this.renderer.removeInputHandler(this.rawListener)
    this.renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, this.focusedRenderableListener)
  }

  public setData(name: string, value: unknown): void {
    if (this.state.core.destroyed) {
      return
    }

    this.runtime.setData(name, value)
  }

  public getData(name: string): unknown {
    if (this.state.core.destroyed) {
      return undefined
    }

    return this.runtime.getData(name)
  }

  public hasPendingSequence(): boolean {
    if (this.state.core.destroyed) {
      return false
    }

    return this.runtime.ensureValidPendingSequence() !== undefined
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    return this.runtime.getPendingSequence()
  }

  public getPendingSequenceParts(): readonly ParsedKeyPart[] {
    return this.runtime.getPendingSequenceParts()
  }

  public createKeyMatcher(key: KeyLike): (input: ActionMapStringifiableKey | null | undefined) => boolean {
    if (this.state.core.destroyed) {
      return () => false
    }

    const matchKey = this.compiler.parseTokenKey(key).matchKey

    return (input) => {
      if (!input) {
        return false
      }

      return getKeyMatchKey(input) === matchKey
    }
  }

  public clearPendingSequence(): void {
    if (this.state.core.destroyed) {
      return
    }

    this.setPendingSequence(null)
  }

  public popPendingSequence(): boolean {
    if (this.state.core.destroyed) {
      return false
    }

    const pending = this.runtime.ensureValidPendingSequence()
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
    return this.runtime.getActiveKeys(options)
  }

  public getCommands(query?: ActionMapCommandQuery): readonly ActionMapCommandRecord[] {
    return this.commands.getCommands(query)
  }

  public runCommand(cmd: string, options?: ActionMapRunCommandOptions): ActionMapRunCommandResult {
    return this.commands.runCommand(cmd, options)
  }

  public hook<TName extends ActionMapHookName>(
    name: TName,
    fn: ActionMapHookListener<ActionMapHooks[TName]>,
  ): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.hooks.hook(name, fn)
  }

  public on<TName extends keyof ActionMapEvents>(name: TName, fn: EmitterListener<ActionMapEvents[TName]>): this {
    if (this.state.core.destroyed) {
      return this
    }

    this.events.hook(name, fn)
    return this
  }

  public off<TName extends keyof ActionMapEvents>(name: TName, fn: EmitterListener<ActionMapEvents[TName]>): this {
    this.events.off(name, fn)
    return this
  }

  public registerLayer(layer: ActionMapLayer): () => void {
    return this.layers.registerLayer(layer)
  }

  public registerLayerFields(fields: Record<string, ActionMapLayerFieldCompiler>): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return registerFieldCompilers(fields, {
      kind: "layer",
      reservedFields: RESERVED_LAYER_FIELDS,
      registeredFields: this.state.config.layerFields,
      emitError: (message) => {
        this.emitError(message)
      },
    })
  }

  public registerBindingCompiler(compiler: ActionMapBindingCompiler): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.state.config.bindingCompilers.append(compiler)
  }

  public prependBindingParser(parser: ActionMapBindingParser): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.state.config.bindingParsers.prepend(parser)
  }

  public appendBindingParser(parser: ActionMapBindingParser): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.state.config.bindingParsers.append(parser)
  }

  public clearBindingParsers(): void {
    if (this.state.core.destroyed) {
      return
    }

    this.state.config.bindingParsers.clear()
  }

  public setBindingSyntax(syntax: ActionMapBindingSyntax): void {
    if (this.state.core.destroyed) {
      return
    }

    this.state.config.bindingSyntax = syntax
  }

  public clearBindingSyntax(): void {
    if (this.state.core.destroyed) {
      return
    }

    this.state.config.bindingSyntax = undefined
  }

  public registerToken(token: ActionMapToken): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    let normalizedToken: string

    try {
      normalizedToken = this.compiler.normalizeTokenName(token.name)
    } catch (error) {
      this.emitError(getErrorMessage(error, "Failed to register action map token"), error)
      return NOOP
    }

    if (this.state.config.tokens.has(normalizedToken)) {
      this.emitError(`ActionMap token "${normalizedToken}" is already registered`)
      return NOOP
    }

    let parsedToken: ParsedKeyPart

    try {
      parsedToken = this.compiler.parseTokenKey(token.key)
    } catch (error) {
      this.emitError(getErrorMessage(error, `Failed to register action map token "${normalizedToken}"`), error)
      return NOOP
    }

    const registeredToken: ParsedKeyToken = {
      stroke: parsedToken.stroke,
      matchKey: parsedToken.matchKey,
    }

    const nextTokens = new Map(this.state.config.tokens)
    nextTokens.set(normalizedToken, registeredToken)

    try {
      this.applyTokenState(nextTokens)
    } catch (error) {
      this.emitError(getErrorMessage(error, `Failed to register action map token "${normalizedToken}"`), error)
      return NOOP
    }

    return () => {
      const current = this.state.config.tokens.get(normalizedToken)
      if (current === registeredToken) {
        const nextTokens = new Map(this.state.config.tokens)
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
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.state.config.bindingExpanders.prepend(expander)
  }

  public appendBindingExpander(expander: ActionMapBindingExpander): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.state.config.bindingExpanders.append(expander)
  }

  public clearBindingExpanders(): void {
    if (this.state.core.destroyed) {
      return
    }

    this.state.config.bindingExpanders.clear()
  }

  public registerBindingFields(fields: Record<string, ActionMapBindingFieldCompiler>): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return registerFieldCompilers(fields, {
      kind: "binding",
      reservedFields: RESERVED_BINDING_FIELDS,
      registeredFields: this.state.config.bindingFields,
      emitError: (message) => {
        this.emitError(message)
      },
    })
  }

  public registerCommandFields(fields: Record<string, ActionMapCommandFieldCompiler>): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return registerFieldCompilers(fields, {
      kind: "command",
      reservedFields: RESERVED_COMMAND_FIELDS,
      registeredFields: this.state.config.commandFields,
      emitError: (message) => {
        this.emitError(message)
      },
    })
  }

  public registerCommandResolver(resolver: ActionMapCommandResolver): () => void {
    return this.commands.registerCommandResolver(resolver)
  }

  public registerEventMatchResolver(resolver: ActionMapEventMatchResolver): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.state.config.eventMatchResolvers.append(resolver)
  }

  public clearEventMatchResolvers(): void {
    if (this.state.core.destroyed) {
      return
    }

    this.state.config.eventMatchResolvers.clear()
  }

  public onKeyInput(
    fn: (ctx: ActionMapKeyInputContext) => void,
    options?: { priority?: number; release?: boolean },
  ): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.state.config.keyHooks.hook(fn, {
      priority: options?.priority ?? 0,
      release: options?.release ?? false,
    })
  }

  public onRawInput(fn: (ctx: ActionMapRawInputContext) => void, options?: { priority?: number }): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    return this.state.config.rawHooks.hook(fn, {
      priority: options?.priority ?? 0,
    })
  }

  public registerCommands(commands: ActionMapCommandDefinition[]): () => void {
    return this.commands.registerCommands(commands)
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
    return this.notify.runWithStateChangeBatch(fn)
  }

  private queueStateChange(): void {
    this.notify.queueStateChange()
  }

  private emitError(message: string, cause?: unknown): void {
    this.notify.emitError(message, cause)
  }

  private applyTokenState(nextTokens: Map<string, ParsedKeyToken>): void {
    this.layers.applyTokenState(nextTokens)
  }

  private setPendingSequence(next: PendingSequenceState | null): void {
    this.runtime.setPendingSequence(next)
  }

  private warnOnce(key: string, message: string): void {
    this.notify.warnOnce(key, message)
  }

  private warnUnknownField(kind: "binding" | "layer", fieldName: string): void {
    this.warnOnce(`${kind}:${fieldName}`, `[ActionMap] Unknown ${kind} field "${fieldName}" was ignored`)
  }

  private warnUnknownToken(token: string, sequence: string): void {
    this.warnOnce(`token:${token}`, `[ActionMap] Unknown token "${token}" in key sequence "${sequence}" was ignored`)
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
