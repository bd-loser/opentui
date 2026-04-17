import type { Renderable } from "../../Renderable.js"
import { CliRenderEvents, type CliRenderer } from "../../renderer.js"
import { KeyEvent } from "../../lib/KeyHandler.js"
import type {
  CompiledBinding,
  ActionMapActiveKey,
  ActionMapActiveKeyOptions,
  ActionMapBindingCompiler,
  ActionMapBindingExpander,
  ActionMapBindingParser,
  ActionMapBindingSyntax,
  ActionMapBindingFieldCompiler,
  ActionMapBindingInput,
  ActionMapHookListener,
  ActionMapHooks,
  ActionMapEvents,
  ActionMapParsedBindingInput,
  ActionMapCommandDefinition,
  ActionMapCommandFieldCompiler,
  ActionMapCommandQuery,
  ActionMapCommandRecord,
  ActionMapRunCommandOptions,
  ActionMapRunCommandResult,
  ActionMapCommandResolver,
  ActionMapEventData,
  ActionMapKeyInputContext,
  ActionMapLayer,
  ActionMapLayerFieldCompiler,
  ActionMapRawInputContext,
  ActionMapEventMatchResolver,
  ActionMapToken,
  ActionMapUnresolvedCommandContext,
  ParsedKeyPart,
  ParsedKeyToken,
  ParsedKeyStroke,
  PendingSequenceState,
  RegisteredCommand,
  RegisteredLayer,
  RuntimeMatchable,
  SequenceNode,
} from "./types.js"
import { getErrorMessage, snapshotParsedBindingInput, stringifyKeySequence } from "./utils.js"
import { ActionMapCommands } from "./action-map-commands.js"
import { ActionMapCompiler } from "./action-map-compiler.js"
import { ActionMapConditions } from "./action-map-conditions.js"
import { ActionMapDispatch } from "./action-map-dispatch.js"
import { ActionMapLayers, RESERVED_LAYER_FIELDS } from "./action-map-layers.js"
import { ActionMapNotifier } from "./action-map-notify.js"
import { ActionMapProjections } from "./action-map-projections.js"
import { ActionMapRuntime } from "./action-map-runtime.js"
import { createActionMapState, resetActionMapState } from "./action-map-state.js"
import { defaultBindingParser, defaultBindingSyntax, defaultEventMatchResolver } from "./default-parser.js"
import { Emitter, type EmitterListener } from "./emitter.js"

const actionMapsByRenderer = new WeakMap<CliRenderer, ActionMap>()
const NOOP = (): void => {}

export const RESERVED_BINDING_FIELDS = new Set(["key", "cmd", "event", "preventDefault", "fallthrough"])

const RESERVED_COMMAND_FIELDS = new Set(["name", "run"])

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
  private readonly projections: ActionMapProjections

  private readonly keypressListener: (event: KeyEvent) => void
  private readonly keyreleaseListener: (event: KeyEvent) => void
  private readonly rawListener: (sequence: string) => boolean
  private readonly focusedRenderableListener: (focused: Renderable | null) => void

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.hooks = new Emitter<ActionMapHooks>((name, error) => {
      this.notify.reportHookError(name, error)
    })
    this.runtime = new ActionMapRuntime(this.state, this.renderer)
    this.notify = new ActionMapNotifier(this.state, this.events, this.hooks, {
      getPendingSequenceStrokes: (pending) => {
        return pending ? this.projections.collectSequenceStrokesFromNode(pending.node) : []
      },
    })
    this.conditions = new ActionMapConditions(this.state, this.notify)
    this.commands = new ActionMapCommands(this.state, this.notify, this.runtime, {
      actionMap: this,
      ensureValidPendingSequence: () => {
        this.ensureValidPendingSequence()
      },
      handleUnresolvedCommand: (command, binding) => {
        this.handleUnresolvedCommand(command, binding)
      },
    })
    this.compiler = new ActionMapCompiler(this.state, this.notify, this.commands, this.conditions, {
      reservedBindingFields: RESERVED_BINDING_FIELDS,
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
      warnUnknownToken: (token, sequence) => {
        this.warnUnknownToken(token, sequence)
      },
    })
    this.layers = new ActionMapLayers(this.state, this.notify, this.conditions, {
      compiler: this.compiler,
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
    })
    this.projections = new ActionMapProjections(this.state, this.notify, this.runtime, this.layers, this.conditions)
    this.dispatch = new ActionMapDispatch(
      this.state,
      this.notify,
      this,
      this.runtime,
      this.layers,
      this.projections,
      this.conditions,
      (name, value) => this.setData(name, value),
    )
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

    this.runWithStateChangeBatch(() => {
      if (value === undefined) {
        if (!(name in this.state.runtime.data)) {
          return
        }

        delete this.state.runtime.data[name]
        this.state.runtime.dataVersion += 1
        this.conditions.invalidateRuntimeConditionKey(name)
        this.projections.ensureValidPendingSequence()
        this.queueStateChange()
        return
      }

      if (Object.is(this.state.runtime.data[name], value)) {
        return
      }

      this.state.runtime.data[name] = value
      this.state.runtime.dataVersion += 1
      this.conditions.invalidateRuntimeConditionKey(name)
      this.projections.ensureValidPendingSequence()
      this.queueStateChange()
    })
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

    return this.projections.ensureValidPendingSequence() !== undefined
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    return this.projections.getPendingSequence()
  }

  public getPendingSequenceParts(): readonly ParsedKeyPart[] {
    return this.projections.getPendingSequenceParts()
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

    const pending = this.projections.ensureValidPendingSequence()
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
    return this.projections.getActiveKeys(options)
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

    const entries = Object.entries(fields)
    const registered: Array<[string, ActionMapLayerFieldCompiler]> = []

    for (const [name] of entries) {
      if (RESERVED_LAYER_FIELDS.has(name)) {
        this.emitError(`ActionMap layer field "${name}" is reserved`)
        continue
      }

      if (this.state.config.layerFields.has(name)) {
        this.emitError(`ActionMap layer field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      if (RESERVED_LAYER_FIELDS.has(name) || this.state.config.layerFields.has(name)) {
        continue
      }

      this.state.config.layerFields.set(name, compiler)
      registered.push([name, compiler])
    }

    return () => {
      for (const [name, compiler] of registered) {
        const current = this.state.config.layerFields.get(name)
        if (current === compiler) {
          this.state.config.layerFields.delete(name)
        }
      }
    }
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

    const entries = Object.entries(fields)
    const registered: Array<[string, ActionMapBindingFieldCompiler]> = []

    for (const [name] of entries) {
      if (RESERVED_BINDING_FIELDS.has(name)) {
        this.emitError(`ActionMap binding field "${name}" is reserved`)
        continue
      }

      if (this.state.config.bindingFields.has(name)) {
        this.emitError(`ActionMap binding field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      if (RESERVED_BINDING_FIELDS.has(name) || this.state.config.bindingFields.has(name)) {
        continue
      }

      this.state.config.bindingFields.set(name, compiler)
      registered.push([name, compiler])
    }

    return () => {
      for (const [name, compiler] of registered) {
        const current = this.state.config.bindingFields.get(name)
        if (current === compiler) {
          this.state.config.bindingFields.delete(name)
        }
      }
    }
  }

  public registerCommandFields(fields: Record<string, ActionMapCommandFieldCompiler>): () => void {
    if (this.state.core.destroyed) {
      return NOOP
    }

    const entries = Object.entries(fields)
    const registered: Array<[string, ActionMapCommandFieldCompiler]> = []

    for (const [name] of entries) {
      if (RESERVED_COMMAND_FIELDS.has(name)) {
        this.emitError(`ActionMap command field "${name}" is reserved`)
        continue
      }

      if (this.state.config.commandFields.has(name)) {
        this.emitError(`ActionMap command field "${name}" is already registered`)
      }
    }

    for (const [name, compiler] of entries) {
      if (RESERVED_COMMAND_FIELDS.has(name) || this.state.config.commandFields.has(name)) {
        continue
      }

      this.state.config.commandFields.set(name, compiler)
      registered.push([name, compiler])
    }

    return () => {
      for (const [name, compiler] of registered) {
        const current = this.state.config.commandFields.get(name)
        if (current === compiler) {
          this.state.config.commandFields.delete(name)
        }
      }
    }
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

  private refreshBindingCommandResolution(): void {
    this.commands.refreshBindingCommandResolution()
  }

  private resolveCompiledBindingCommand(binding: CompiledBinding): void {
    this.commands.resolveCompiledBindingCommand(binding)
  }

  private getCommandRecord(command: RegisteredCommand): ActionMapCommandRecord {
    return this.commands.getCommandRecord(command)
  }

  private nodeHasReachableBindings(node: SequenceNode): boolean {
    return this.projections.nodeHasReachableBindings(node)
  }

  private hasNoConditions(target: RuntimeMatchable): boolean {
    return this.conditions.hasNoConditions(target)
  }

  private matchesConditions(target: RuntimeMatchable): boolean {
    return this.conditions.matchesConditions(target)
  }

  private layerMatchesRuntimeState(layer: RegisteredLayer): boolean {
    return this.conditions.layerMatchesRuntimeState(layer)
  }

  private setPendingSequence(next: PendingSequenceState | null): void {
    this.notify.setPendingSequence(next)
  }

  private getFocusedRenderable(): Renderable | null {
    return this.runtime.getFocusedRenderable()
  }

  private layerCanCacheActiveKeys(layer: RegisteredLayer): boolean {
    return this.layers.layerCanCacheActiveKeys(layer)
  }

  private activeLayersCanCacheActiveKeys(activeLayers: readonly RegisteredLayer[]): boolean {
    return this.layers.activeLayersCanCacheActiveKeys(activeLayers)
  }

  private getActiveLayers(focused: Renderable | null): RegisteredLayer[] {
    return this.layers.getActiveLayers(focused)
  }

  private isLayerActiveForFocused(layer: RegisteredLayer, focused: Renderable | null): boolean {
    return this.layers.isLayerActiveForFocused(layer, focused)
  }

  private getReadonlyData(): Readonly<ActionMapEventData> {
    return this.notify.getReadonlyData()
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
      binding: snapshotParsedBindingInput(binding.sourceBinding),
      scope: binding.sourceScope,
      target: binding.sourceTarget,
    }

    this.hooks.emit("unresolvedCommand", context)
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

  private ensureValidPendingSequence(): PendingSequenceState | undefined {
    return this.projections.ensureValidPendingSequence()
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
