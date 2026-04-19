import type {
  ActiveKey,
  ActiveKeyOptions,
  BindingInput,
  BindingExpander,
  BindingParser,
  BindingSyntax,
  BindingFieldCompiler,
  Bindings,
  BindingTransformer,
  Events,
  Hooks,
  CommandFieldCompiler,
  CommandQuery,
  CommandRecord,
  KeymapEvent,
  KeymapHost,
  LayerAnalyzer,
  Listener,
  RunCommandOptions,
  RunCommandResult,
  CommandResolver,
  KeyInterceptOptions,
  KeyInputContext,
  Layer,
  LayerFieldCompiler,
  RawInterceptOptions,
  RawInputContext,
  EventMatchResolver,
  KeyStringifyInput,
  KeyToken,
  KeyLike,
  KeySequencePart,
  ResolvedKeyToken,
} from "./types.js"
import {
  buildBindingKey,
  getErrorMessage,
  normalizeBindingInputs,
  normalizeCommandName,
  normalizeKeyStroke,
} from "./lib/utils.js"
import { RESERVED_BINDING_FIELDS, RESERVED_COMMAND_FIELDS, RESERVED_LAYER_FIELDS } from "./schema.js"
import { CommandService } from "./services/commands.js"
import { CompilerService } from "./services/compiler.js"
import { ConditionService } from "./services/conditions.js"
import { DispatchService } from "./services/dispatch.js"
import { LayerService } from "./services/layers.js"
import { defaultBindingParser, defaultBindingSyntax, defaultEventMatchResolver } from "./lib/default-parser.js"
import { Emitter, type EmitterListener } from "./lib/emitter.js"
import { NotificationService } from "./services/notify.js"
import { ProjectionService } from "./services/projection.js"
import { RuntimeService } from "./services/runtime.js"
import { createKeymapState } from "./services/state.js"

const NOOP = (): void => {}

type DiagnosticEvents<TTarget extends object, TEvent extends KeymapEvent> = Pick<Events<TTarget, TEvent>, "warning" | "error">

type FieldKind = "layer" | "binding" | "command"

function getKeyMatchKey(input: KeyStringifyInput): string {
  if ("matchKey" in input) {
    return input.matchKey
  }

  if ("stroke" in input) {
    return buildBindingKey(input.stroke)
  }

  return buildBindingKey(normalizeKeyStroke(input))
}

function registerFieldCompilers<T>(
  fields: Record<string, T>,
  options: {
    kind: FieldKind
    reservedFields: ReadonlySet<string>
    registeredFields: Map<string, T>
    emitError(code: string, error: unknown, message: string): void
  },
): () => void {
  const { kind, reservedFields, registeredFields, emitError } = options
  const entries = Object.entries(fields)
  const registered: Array<[string, T]> = []

  for (const [name] of entries) {
    if (reservedFields.has(name)) {
      emitError(`reserved-${kind}-field`, { field: name, kind }, `Keymap ${kind} field "${name}" is reserved`)
      continue
    }

    if (registeredFields.has(name)) {
      emitError(
        `duplicate-${kind}-field`,
        { field: name, kind },
        `Keymap ${kind} field "${name}" is already registered`,
      )
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

export class Keymap<TTarget extends object, TEvent extends KeymapEvent = KeymapEvent> {
  private readonly state = createKeymapState<TTarget, TEvent>()
  private cleanedUp = false
  private readonly resources = new Map<symbol, { count: number; dispose: () => void }>()
  private readonly cleanupListeners: Array<() => void> = []
  // Reuse `Emitter`, but keep its `onError` hook as a no-op so throwing error
  // listeners cannot re-enter `emitError` and loop forever.
  private events = new Emitter<DiagnosticEvents<TTarget, TEvent>>(() => {})
  private hooks: Emitter<Hooks<TTarget, TEvent>>
  private readonly notify: NotificationService<TTarget, TEvent>
  private readonly runtime: RuntimeService<TTarget, TEvent>
  private readonly conditions: ConditionService<TTarget, TEvent>
  private readonly commands: CommandService<TTarget, TEvent>
  private readonly projection: ProjectionService<TTarget, TEvent>
  private readonly compiler: CompilerService<TTarget, TEvent>
  private readonly dispatch: DispatchService<TTarget, TEvent>
  private readonly layers: LayerService<TTarget, TEvent>

  private readonly keypressListener: (event: TEvent) => void
  private readonly keyreleaseListener: (event: TEvent) => void
  private readonly rawListener: (sequence: string) => boolean
  private readonly focusedTargetListener: (focused: TTarget | null) => void

  constructor(private readonly host: KeymapHost<TTarget, TEvent>) {
    if (host.isDestroyed) {
      throw new Error("Cannot create a keymap for a destroyed host")
    }

    this.hooks = new Emitter<Hooks<TTarget, TEvent>>((name, error) => {
      this.notify.reportListenerError(name, error)
    })
    this.notify = new NotificationService(this.state, this.events, this.hooks)
    this.conditions = new ConditionService(this.state, this.notify)
    this.projection = new ProjectionService(this.state, this.host, this.hooks, this.notify, this.conditions)
    this.runtime = new RuntimeService(this.state, this.notify, this.conditions, this.projection)
    this.commands = new CommandService(this.state, this.notify, this.runtime, this.projection, this.hooks, {
      keymap: this,
      createCommandEvent: () => this.host.createCommandEvent(),
    })
    this.compiler = new CompilerService(this.state, this.notify, this.commands, this.conditions, {
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
      warnUnknownToken: (token, sequence) => {
        this.warnUnknownToken(token, sequence)
      },
    })
    this.layers = new LayerService(this.state, this.notify, this.conditions, this.projection, {
      compiler: this.compiler,
      commands: this.commands,
      host: this.host,
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
    })
    this.dispatch = new DispatchService(
      this.state,
      this.notify,
      this.runtime,
      this.projection,
      this.conditions,
      this.commands,
      this.compiler,
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
    this.focusedTargetListener = (focused) => {
      this.handleFocusedTargetChange(focused)
    }

    this.cleanupListeners.push(this.host.onKeyPress(this.keypressListener))
    this.cleanupListeners.push(this.host.onKeyRelease(this.keyreleaseListener))
    if (this.host.onRawInput) {
      this.cleanupListeners.push(this.host.onRawInput(this.rawListener))
    }
    this.cleanupListeners.push(this.host.onFocusChange(this.focusedTargetListener))
    this.cleanupListeners.push(this.host.onDestroy(() => {
      this.cleanup()
    }))
  }

  private cleanup(): void {
    if (this.cleanedUp) {
      return
    }

    this.cleanedUp = true

    this.projection.setPendingSequence(null)

    for (const resource of this.resources.values()) {
      resource.dispose()
    }
    this.resources.clear()

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

    for (const cleanupListener of this.cleanupListeners.splice(0)) {
      cleanupListener()
    }
  }

  public setData(name: string, value: unknown): void {
    this.runtime.setData(name, value)
  }

  public getData(name: string): unknown {
    return this.runtime.getData(name)
  }

  public hasPendingSequence(): boolean {
    return this.projection.ensureValidPendingSequence() !== undefined
  }

  public getPendingSequence(): readonly KeySequencePart[] {
    return this.projection.getPendingSequence()
  }

  public createKeyMatcher(key: KeyLike): (input: KeyStringifyInput | null | undefined) => boolean {
    const matchKey = this.compiler.parseTokenKey(key).matchKey

    return (input) => {
      if (!input) {
        return false
      }

      return getKeyMatchKey(input) === matchKey
    }
  }

  public clearPendingSequence(): void {
    this.projection.setPendingSequence(null)
  }

  public popPendingSequence(): boolean {
    const pending = this.projection.ensureValidPendingSequence()
    if (!pending) {
      return false
    }

    if (pending.node.depth <= 1) {
      this.projection.setPendingSequence(null)
      return true
    }

    const parent = pending.node.parent
    if (!parent || !parent.stroke) {
      this.projection.setPendingSequence(null)
      return true
    }

    this.projection.setPendingSequence({
      layer: pending.layer,
      node: parent,
    })
    return true
  }

  public getActiveKeys(options?: ActiveKeyOptions): readonly ActiveKey<TTarget, TEvent>[] {
    return this.projection.getActiveKeys(options)
  }

  public getCommands(query?: CommandQuery<TTarget>): readonly CommandRecord[] {
    return this.projection.getCommands(query)
  }

  public normalizeCommandName(name: string): string {
    return normalizeCommandName(name)
  }

  public normalizeBindings(bindings: Bindings<TTarget, TEvent>): BindingInput<TTarget, TEvent>[] {
    return normalizeBindingInputs(bindings)
  }

  public acquireResource(key: symbol, setup: () => () => void): () => void {
    if (this.cleanedUp || this.host.isDestroyed) {
      throw new Error("Cannot use a keymap after its host was destroyed")
    }

    const existing = this.resources.get(key)
    if (existing) {
      existing.count += 1
      return () => {
        this.releaseResource(key, existing)
      }
    }

    const dispose = setup()
    const resource = { count: 1, dispose }
    this.resources.set(key, resource)

    return () => {
      this.releaseResource(key, resource)
    }
  }

  public runCommand(cmd: string, options?: RunCommandOptions<TTarget, TEvent>): RunCommandResult {
    return this.commands.runCommand(cmd, options)
  }

  public on(name: "state", fn: Listener<Events<TTarget, TEvent>["state"]>): () => void

  public on(name: "pendingSequence", fn: Listener<Events<TTarget, TEvent>["pendingSequence"]>): () => void

  public on(name: "unresolvedCommand", fn: Listener<Events<TTarget, TEvent>["unresolvedCommand"]>): () => void

  public on(name: "warning", fn: Listener<Events<TTarget, TEvent>["warning"]>): () => void

  public on(name: "error", fn: Listener<Events<TTarget, TEvent>["error"]>): () => void

  public on(
    name: keyof Events<TTarget, TEvent>,
    fn: (() => void) | ((value: Events<TTarget, TEvent>[keyof Events<TTarget, TEvent>]) => void),
  ): () => void {
    if (name === "warning") {
      return this.events.hook(name, fn as EmitterListener<Events<TTarget, TEvent>["warning"]>)
    }

    if (name === "error") {
      return this.events.hook(name, fn as EmitterListener<Events<TTarget, TEvent>["error"]>)
    }

    return this.hooks.hook(name, fn as Listener<Hooks<TTarget, TEvent>[typeof name]>)
  }

  public intercept(name: "key", fn: (ctx: KeyInputContext<TEvent>) => void, options?: KeyInterceptOptions): () => void

  public intercept(name: "raw", fn: (ctx: RawInputContext) => void, options?: RawInterceptOptions): () => void

  public intercept(
    name: "key" | "raw",
    fn: ((ctx: KeyInputContext<TEvent>) => void) | ((ctx: RawInputContext) => void),
    options?: KeyInterceptOptions | RawInterceptOptions,
  ): () => void {
    if (name === "key") {
      const keyOptions = options as KeyInterceptOptions | undefined
      return this.state.config.keyHooks.register(fn as (ctx: KeyInputContext<TEvent>) => void, {
        priority: keyOptions?.priority ?? 0,
        release: keyOptions?.release ?? false,
      })
    }

    const rawOptions = options as RawInterceptOptions | undefined
    return this.state.config.rawHooks.register(fn as (ctx: RawInputContext) => void, {
      priority: rawOptions?.priority ?? 0,
    })
  }

  public registerLayer(layer: Layer<TTarget, TEvent>): () => void {
    return this.layers.registerLayer(layer)
  }

  public registerLayerFields(fields: Record<string, LayerFieldCompiler>): () => void {
    return registerFieldCompilers(fields, {
      kind: "layer",
      reservedFields: RESERVED_LAYER_FIELDS,
      registeredFields: this.state.config.layerFields,
      emitError: (code, error, message) => {
        this.notify.emitError(code, error, message)
      },
    })
  }

  public prependBindingTransformer(transformer: BindingTransformer<TTarget, TEvent>): () => void {
    return this.state.config.bindingTransformers.prepend(transformer)
  }

  public appendBindingTransformer(transformer: BindingTransformer<TTarget, TEvent>): () => void {
    return this.state.config.bindingTransformers.append(transformer)
  }

  public clearBindingTransformers(): void {
    this.state.config.bindingTransformers.clear()
  }

  public prependBindingParser(parser: BindingParser): () => void {
    return this.state.config.bindingParsers.prepend(parser)
  }

  public appendBindingParser(parser: BindingParser): () => void {
    return this.state.config.bindingParsers.append(parser)
  }

  public clearBindingParsers(): void {
    this.state.config.bindingParsers.clear()
  }

  public setBindingSyntax(syntax: BindingSyntax): void {
    this.state.config.bindingSyntax = syntax
  }

  public clearBindingSyntax(): void {
    this.state.config.bindingSyntax = undefined
  }

  public registerToken(token: KeyToken): () => void {
    let normalizedToken: string

    try {
      normalizedToken = this.compiler.normalizeTokenName(token.name)
    } catch (error) {
      this.notify.emitError(
        "token-name-normalize-error",
        error,
        getErrorMessage(error, "Failed to register keymap token"),
      )
      return NOOP
    }

    if (this.state.config.tokens.has(normalizedToken)) {
      this.notify.emitError(
        "duplicate-token",
        { token: normalizedToken },
        `Keymap token "${normalizedToken}" is already registered`,
      )
      return NOOP
    }

    let parsedToken: KeySequencePart

    try {
      parsedToken = this.compiler.parseTokenKey(token.key)
    } catch (error) {
      this.notify.emitError(
        "token-parse-error",
        error,
        getErrorMessage(error, `Failed to register keymap token "${normalizedToken}"`),
      )
      return NOOP
    }

    const registeredToken: ResolvedKeyToken = {
      stroke: parsedToken.stroke,
      matchKey: parsedToken.matchKey,
    }

    const nextTokens = new Map(this.state.config.tokens)
    nextTokens.set(normalizedToken, registeredToken)

    try {
      this.layers.applyTokenState(nextTokens)
    } catch (error) {
      this.notify.emitError(
        "token-register-error",
        error,
        getErrorMessage(error, `Failed to register keymap token "${normalizedToken}"`),
      )
      return NOOP
    }

    return () => {
      const current = this.state.config.tokens.get(normalizedToken)
      if (current === registeredToken) {
        const nextTokens = new Map(this.state.config.tokens)
        nextTokens.delete(normalizedToken)

        try {
          this.layers.applyTokenState(nextTokens)
        } catch (error) {
          this.notify.emitError(
            "token-unregister-error",
            error,
            getErrorMessage(error, `Failed to unregister keymap token "${normalizedToken}"`),
          )
        }
      }
    }
  }

  public prependBindingExpander(expander: BindingExpander): () => void {
    return this.state.config.bindingExpanders.prepend(expander)
  }

  public appendBindingExpander(expander: BindingExpander): () => void {
    return this.state.config.bindingExpanders.append(expander)
  }

  public clearBindingExpanders(): void {
    this.state.config.bindingExpanders.clear()
  }

  public registerBindingFields(fields: Record<string, BindingFieldCompiler>): () => void {
    return registerFieldCompilers(fields, {
      kind: "binding",
      reservedFields: RESERVED_BINDING_FIELDS,
      registeredFields: this.state.config.bindingFields,
      emitError: (code, error, message) => {
        this.notify.emitError(code, error, message)
      },
    })
  }

  public registerCommandFields(fields: Record<string, CommandFieldCompiler>): () => void {
    return registerFieldCompilers(fields, {
      kind: "command",
      reservedFields: RESERVED_COMMAND_FIELDS,
      registeredFields: this.state.config.commandFields,
      emitError: (code, error, message) => {
        this.notify.emitError(code, error, message)
      },
    })
  }

  public prependCommandResolver(resolver: CommandResolver<TTarget, TEvent>): () => void {
    return this.commands.prependCommandResolver(resolver)
  }

  public appendCommandResolver(resolver: CommandResolver<TTarget, TEvent>): () => void {
    return this.commands.appendCommandResolver(resolver)
  }

  public clearCommandResolvers(): void {
    this.commands.clearCommandResolvers()
  }

  public prependLayerAnalyzer(analyzer: LayerAnalyzer<TTarget, TEvent>): () => void {
    return this.state.config.layerAnalyzers.prepend(analyzer)
  }

  public appendLayerAnalyzer(analyzer: LayerAnalyzer<TTarget, TEvent>): () => void {
    return this.state.config.layerAnalyzers.append(analyzer)
  }

  public clearLayerAnalyzers(): void {
    this.state.config.layerAnalyzers.clear()
  }

  public prependEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void {
    return this.state.config.eventMatchResolvers.prepend(resolver)
  }

  public appendEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void {
    return this.state.config.eventMatchResolvers.append(resolver)
  }

  public clearEventMatchResolvers(): void {
    this.state.config.eventMatchResolvers.clear()
  }

  private handleFocusedTargetChange(_focused: TTarget | null): void {
    this.notify.runWithStateChangeBatch(() => {
      // Any focus change breaks a pending sequence. Prefix dispatch is captured
      // against the state that started it, and changing focus can change the
      // active bindings and their precedence.
      this.projection.setPendingSequence(null)
      this.notify.queueStateChange()
    })
  }

  private warnUnknownField(kind: "binding" | "layer", fieldName: string): void {
    this.notify.warnOnce(
      `${kind}:${fieldName}`,
      `unknown-${kind}-field`,
      { field: fieldName, kind },
      `[Keymap] Unknown ${kind} field "${fieldName}" was ignored`,
    )
  }

  private warnUnknownToken(token: string, sequence: string): void {
    this.notify.warnOnce(
      `token:${token}`,
      "unknown-token",
      { token, sequence },
      `[Keymap] Unknown token "${token}" in key sequence "${sequence}" was ignored`,
    )
  }

  private releaseResource(key: symbol, resource: { count: number; dispose: () => void }): void {
    const current = this.resources.get(key)
    if (current !== resource) {
      return
    }

    resource.count -= 1
    if (resource.count > 0) {
      return
    }

    resource.dispose()
    this.resources.delete(key)
  }
}
