import type { Renderable } from "../../Renderable.js"
import { CliRenderEvents, type CliRenderer } from "../../renderer.js"
import { KeyEvent } from "../../lib/KeyHandler.js"
import type {
  ActiveKey,
  ActiveKeyOptions,
  BindingExpander,
  BindingParser,
  BindingSyntax,
  BindingFieldCompiler,
  BindingTransformer,
  Events,
  Hooks,
  CommandDefinition,
  CommandFieldCompiler,
  CommandQuery,
  CommandRecord,
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
  StringifiableKey,
  Token,
  KeyLike,
  ParsedKeyPart,
  ParsedKeyToken,
  ParsedKeyStroke,
  PendingSequenceState,
} from "./types.js"
import { buildBindingKey, getErrorMessage } from "./lib/utils.js"
import { CommandService, RESERVED_COMMAND_FIELDS } from "./services/commands.js"
import { CompilerService, RESERVED_BINDING_FIELDS } from "./services/compiler.js"
import { ConditionService } from "./services/conditions.js"
import { DispatchService } from "./services/dispatch.js"
import { LayerService, RESERVED_LAYER_FIELDS } from "./services/layers.js"
import { defaultBindingParser, defaultBindingSyntax, defaultEventMatchResolver } from "./lib/default-parser.js"
import { Emitter, type EmitterListener } from "./lib/emitter.js"
import { NotificationService } from "./services/notify.js"
import { RuntimeService } from "./services/runtime.js"
import { createActionMapState } from "./services/state.js"

const actionMapsByRenderer = new WeakMap<CliRenderer, ActionMap>()
const NOOP = (): void => {}

type DiagnosticEvents = Pick<Events, "warning" | "error">

type FieldKind = "layer" | "binding" | "command"

function getKeyMatchKey(input: StringifiableKey): string {
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
    kind: FieldKind
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
  private cleanedUp = false
  // Reuse `Emitter`, but keep its `onError` hook as a no-op so throwing error
  // listeners cannot re-enter `emitError` and loop forever.
  private events = new Emitter<DiagnosticEvents>(() => {})
  private hooks: Emitter<Hooks>
  private readonly notify: NotificationService
  private readonly runtime: RuntimeService
  private readonly conditions: ConditionService
  private readonly commands: CommandService
  private readonly compiler: CompilerService
  private readonly dispatch: DispatchService
  private readonly layers: LayerService

  private readonly keypressListener: (event: KeyEvent) => void
  private readonly keyreleaseListener: (event: KeyEvent) => void
  private readonly rawListener: (sequence: string) => boolean
  private readonly focusedRenderableListener: (focused: Renderable | null) => void

  constructor(renderer: CliRenderer) {
    if (renderer.isDestroyed) {
      throw new Error("Cannot create an action map for a destroyed renderer")
    }

    this.renderer = renderer
    this.hooks = new Emitter<Hooks>((name, error) => {
      this.notify.reportListenerError(name, error)
    })
    this.notify = new NotificationService(this.state, this.events, this.hooks)
    this.conditions = new ConditionService(this.state, this.notify)
    this.runtime = new RuntimeService(this.state, this.renderer, this.hooks, this.notify, this.conditions)
    this.commands = new CommandService(this.state, this.notify, this.runtime, this.hooks, {
      actionMap: this,
    })
    this.compiler = new CompilerService(this.state, this.notify, this.commands, this.conditions, {
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
      warnUnknownToken: (token, sequence) => {
        this.warnUnknownToken(token, sequence)
      },
    })
    this.layers = new LayerService(this.state, this.notify, this.conditions, this.runtime, {
      compiler: this.compiler,
      warnUnknownField: (kind, fieldName) => {
        this.warnUnknownField(kind, fieldName)
      },
    })
    this.dispatch = new DispatchService(
      this.state,
      this.notify,
      this.runtime,
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
    this.focusedRenderableListener = (focused) => {
      this.handleFocusedRenderableChange(focused)
    }

    this.renderer.keyInput.prependListener("keypress", this.keypressListener)
    this.renderer.keyInput.prependListener("keyrelease", this.keyreleaseListener)
    this.renderer.prependInputHandler(this.rawListener)
    this.renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, this.focusedRenderableListener)
    this.renderer.once(CliRenderEvents.DESTROY, () => {
      this.cleanup()
    })
  }

  private cleanup(): void {
    if (this.cleanedUp) {
      return
    }

    this.cleanedUp = true

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

    this.renderer.keyInput.off("keypress", this.keypressListener)
    this.renderer.keyInput.off("keyrelease", this.keyreleaseListener)
    this.renderer.removeInputHandler(this.rawListener)
    this.renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, this.focusedRenderableListener)
  }

  public setData(name: string, value: unknown): void {
    this.runtime.setData(name, value)
  }

  public getData(name: string): unknown {
    return this.runtime.getData(name)
  }

  public hasPendingSequence(): boolean {
    return this.runtime.ensureValidPendingSequence() !== undefined
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    return this.runtime.getPendingSequence()
  }

  public getPendingSequenceParts(): readonly ParsedKeyPart[] {
    return this.runtime.getPendingSequenceParts()
  }

  public createKeyMatcher(key: KeyLike): (input: StringifiableKey | null | undefined) => boolean {
    const matchKey = this.compiler.parseTokenKey(key).matchKey

    return (input) => {
      if (!input) {
        return false
      }

      return getKeyMatchKey(input) === matchKey
    }
  }

  public clearPendingSequence(): void {
    this.setPendingSequence(null)
  }

  public popPendingSequence(): boolean {
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

  public getActiveKeys(options?: ActiveKeyOptions): readonly ActiveKey[] {
    return this.runtime.getActiveKeys(options)
  }

  public getCommands(query?: CommandQuery): readonly CommandRecord[] {
    return this.commands.getCommands(query)
  }

  public normalizeCommandName(name: string): string {
    return this.commands.normalizeCommandName(name)
  }

  public runCommand(cmd: string, options?: RunCommandOptions): RunCommandResult {
    return this.commands.runCommand(cmd, options)
  }

  public on(name: "state", fn: Listener<Events["state"]>): () => void

  public on(name: "pendingSequence", fn: Listener<Events["pendingSequence"]>): () => void

  public on(name: "unresolvedCommand", fn: Listener<Events["unresolvedCommand"]>): () => void

  public on(name: "warning", fn: Listener<Events["warning"]>): () => void

  public on(name: "error", fn: Listener<Events["error"]>): () => void

  public on(name: keyof Events, fn: (() => void) | ((value: Events[keyof Events]) => void)): () => void {
    if (name === "warning") {
      return this.events.hook(name, fn as EmitterListener<Events["warning"]>)
    }

    if (name === "error") {
      return this.events.hook(name, fn as EmitterListener<Events["error"]>)
    }

    return this.hooks.hook(name, fn as Listener<Hooks[typeof name]>)
  }

  public intercept(name: "key", fn: (ctx: KeyInputContext) => void, options?: KeyInterceptOptions): () => void

  public intercept(name: "raw", fn: (ctx: RawInputContext) => void, options?: RawInterceptOptions): () => void

  public intercept(
    name: "key" | "raw",
    fn: ((ctx: KeyInputContext) => void) | ((ctx: RawInputContext) => void),
    options?: KeyInterceptOptions | RawInterceptOptions,
  ): () => void {
    if (name === "key") {
      const keyOptions = options as KeyInterceptOptions | undefined
      return this.state.config.keyHooks.register(fn as (ctx: KeyInputContext) => void, {
        priority: keyOptions?.priority ?? 0,
        release: keyOptions?.release ?? false,
      })
    }

    const rawOptions = options as RawInterceptOptions | undefined
    return this.state.config.rawHooks.register(fn as (ctx: RawInputContext) => void, {
      priority: rawOptions?.priority ?? 0,
    })
  }

  public registerLayer(layer: Layer): () => void {
    return this.layers.registerLayer(layer)
  }

  public registerLayerFields(fields: Record<string, LayerFieldCompiler>): () => void {
    return registerFieldCompilers(fields, {
      kind: "layer",
      reservedFields: RESERVED_LAYER_FIELDS,
      registeredFields: this.state.config.layerFields,
      emitError: (message) => {
        this.emitError(message)
      },
    })
  }

  public registerBindingTransformer(transformer: BindingTransformer): () => void {
    return this.state.config.bindingTransformers.append(transformer)
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

  public registerToken(token: Token): () => void {
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
      emitError: (message) => {
        this.emitError(message)
      },
    })
  }

  public registerCommandFields(fields: Record<string, CommandFieldCompiler>): () => void {
    return registerFieldCompilers(fields, {
      kind: "command",
      reservedFields: RESERVED_COMMAND_FIELDS,
      registeredFields: this.state.config.commandFields,
      emitError: (message) => {
        this.emitError(message)
      },
    })
  }

  public registerCommandResolver(resolver: CommandResolver): () => void {
    return this.commands.registerCommandResolver(resolver)
  }

  public registerEventMatchResolver(resolver: EventMatchResolver): () => void {
    return this.state.config.eventMatchResolvers.append(resolver)
  }

  public clearEventMatchResolvers(): void {
    this.state.config.eventMatchResolvers.clear()
  }

  public registerCommands(commands: CommandDefinition[]): () => void {
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
  if (renderer.isDestroyed) {
    throw new Error("Cannot create an action map for a destroyed renderer")
  }

  const existing = actionMapsByRenderer.get(renderer)
  if (existing) {
    return existing
  }

  const actionMap = new ActionMap(renderer)
  actionMapsByRenderer.set(renderer, actionMap)

  renderer.once(CliRenderEvents.DESTROY, () => {
    actionMapsByRenderer.delete(renderer)
  })

  return actionMap
}
