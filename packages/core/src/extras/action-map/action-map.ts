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
  ActionMapReactiveMatcher,
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
  RuntimeMatcher,
  SequenceNode,
} from "./types.js"
import { getErrorMessage, snapshotParsedBindingInput, stringifyKeySequence } from "./utils.js"
import { ActionMapCommands } from "./action-map-commands.js"
import { ActionMapCompiler } from "./action-map-compiler.js"
import { ActionMapDispatch } from "./action-map-dispatch.js"
import { ActionMapLayers, RESERVED_LAYER_FIELDS } from "./action-map-layers.js"
import { ActionMapNotifier } from "./action-map-notify.js"
import { ActionMapProjections } from "./action-map-projections.js"
import { createActionMapState, resetActionMapState } from "./action-map-state.js"
import { defaultBindingParser, defaultBindingSyntax, defaultEventMatchResolver } from "./default-parser.js"
import { Emitter, type EmitterListener } from "./emitter.js"

const actionMapsByRenderer = new WeakMap<CliRenderer, ActionMap>()
const NOOP = (): void => {}

export const RESERVED_BINDING_FIELDS = new Set(["key", "cmd", "event", "preventDefault", "fallthrough"])

const RESERVED_COMMAND_FIELDS = new Set(["name", "run"])

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

export class ActionMap {
  public readonly renderer: CliRenderer

  private readonly state = createActionMapState()
  // Reuse `Emitter`, but keep its `onError` hook as a no-op so throwing error
  // listeners cannot re-enter `emitError` and loop forever.
  private events = new Emitter<ActionMapEvents>(() => {})
  private hooks: Emitter<ActionMapHooks>
  private readonly notify: ActionMapNotifier
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
    this.projections = new ActionMapProjections(this.state, {
      getFocusedRenderable: () => this.getFocusedRenderable(),
      ensureValidPendingSequence: () => this.ensureValidPendingSequence(),
      getActiveLayers: (focused) => this.getActiveLayers(focused),
      layerCanCacheActiveKeys: (layer) => this.layerCanCacheActiveKeys(layer),
      activeLayersCanCacheActiveKeys: (activeLayers) => this.activeLayersCanCacheActiveKeys(activeLayers),
      matchesConditions: (target) => this.matchesConditions(target),
      hasNoConditions: (target) => this.hasNoConditions(target),
    })
    this.notify = new ActionMapNotifier(this.state, this.events, this.hooks, {
      getPendingSequenceStrokes: (pending) => {
        return pending ? this.projections.collectSequenceStrokesFromNode(pending.node) : []
      },
    })
    this.commands = new ActionMapCommands(this.state, this.notify, {
      actionMap: this,
      getFocusedRenderable: () => this.getFocusedRenderable(),
      getReadonlyData: () => this.getReadonlyData(),
      ensureValidPendingSequence: () => {
        this.ensureValidPendingSequence()
      },
      handleUnresolvedCommand: (command, binding) => {
        this.handleUnresolvedCommand(command, binding)
      },
    })
    this.compiler = new ActionMapCompiler(this.state, this.notify, this.commands, {
      reservedBindingFields: RESERVED_BINDING_FIELDS,
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
      warnUnknownToken: (token, sequence) => {
        this.warnUnknownToken(token, sequence)
      },
      buildRuntimeMatcher: (matcher, source) => {
        return buildRuntimeMatcher(matcher, source)
      },
    })
    this.layers = new ActionMapLayers(this.state, this.notify, {
      compiler: this.compiler,
      registerRuntimeMatchable: (target) => {
        this.registerRuntimeMatchable(target)
      },
      unregisterRuntimeMatchable: (target) => {
        this.unregisterRuntimeMatchable(target)
      },
      setPendingSequence: (next) => {
        this.setPendingSequence(next)
      },
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
      buildRuntimeMatcher: (matcher, source) => {
        return buildRuntimeMatcher(matcher, source)
      },
    })
    this.dispatch = new ActionMapDispatch(this.state, this.notify, {
      actionMap: this,
      getFocusedRenderable: () => this.getFocusedRenderable(),
      getActiveLayers: (focused) => this.getActiveLayers(focused),
      ensureValidPendingSequence: () => this.ensureValidPendingSequence(),
      setPendingSequence: (next) => this.setPendingSequence(next),
      getReadonlyData: () => this.getReadonlyData(),
      setData: (name, value) => this.setData(name, value),
      matchesConditions: (target) => this.matchesConditions(target),
      hasNoConditions: (target) => this.hasNoConditions(target),
      nodeHasReachableBindings: (node) => this.nodeHasReachableBindings(node),
    })
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
      this.unregisterRuntimeMatchable(layer)
      for (const binding of layer.compiledBindings) {
        this.unregisterRuntimeMatchable(binding)
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
        this.invalidateRuntimeConditionKey(name)
        this.ensureValidPendingSequence()
        this.queueStateChange()
        return
      }

      if (Object.is(this.state.runtime.data[name], value)) {
        return
      }

      this.state.runtime.data[name] = value
      this.state.runtime.dataVersion += 1
      this.invalidateRuntimeConditionKey(name)
      this.ensureValidPendingSequence()
      this.queueStateChange()
    })
  }

  public getData(name: string): unknown {
    if (this.state.core.destroyed) {
      return undefined
    }

    return this.state.runtime.data[name]
  }

  public hasPendingSequence(): boolean {
    if (this.state.core.destroyed) {
      return false
    }

    return this.ensureValidPendingSequence() !== undefined
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

  private matchRequirements(requires: readonly [name: string, value: unknown][]): boolean {
    if (requires.length === 0) {
      return true
    }

    for (const [name, value] of requires) {
      if (!Object.is(this.state.runtime.data[name], value)) {
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
        this.emitError(getErrorMessage(error, `Failed to subscribe to reactive matcher from ${matcher.source}`), error)
      }
    }

    if (target.conditionKeys.length > 0) {
      for (const key of target.conditionKeys) {
        const dependents = this.state.conditions.runtimeKeyDependents.get(key)
        if (dependents) {
          dependents.add(target)
          continue
        }

        this.state.conditions.runtimeKeyDependents.set(key, new Set([target]))
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
        this.emitError(getErrorMessage(error, `Failed to dispose reactive matcher from ${matcher.source}`), error)
      }

      matcher.dispose = undefined
    }

    if (target.conditionKeys.length === 0) {
      return
    }

    for (const key of target.conditionKeys) {
      const dependents = this.state.conditions.runtimeKeyDependents.get(key)
      if (!dependents) {
        continue
      }

      dependents.delete(target)
      if (dependents.size === 0) {
        this.state.conditions.runtimeKeyDependents.delete(key)
      }
    }
  }

  private invalidateRuntimeConditionKey(name: string): void {
    const dependents = this.state.conditions.runtimeKeyDependents.get(name)
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
    if (this.state.layers.layersWithConditions === 0 || this.hasNoConditions(layer)) {
      return true
    }

    return this.matchesConditions(layer)
  }

  private setPendingSequence(next: PendingSequenceState | null): void {
    this.notify.setPendingSequence(next)
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
    if (!this.state.runtime.pendingSequence) {
      return undefined
    }

    const focused = this.getFocusedRenderable()

    if (
      !this.state.layers.layers.has(this.state.runtime.pendingSequence.layer) ||
      !this.isLayerActiveForFocused(this.state.runtime.pendingSequence.layer, focused)
    ) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.layerMatchesRuntimeState(this.state.runtime.pendingSequence.layer)) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.nodeHasReachableBindings(this.state.runtime.pendingSequence.node)) {
      this.setPendingSequence(null)
      return undefined
    }

    return this.state.runtime.pendingSequence
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
