import type { Renderable } from "../../Renderable.js"
import { CliRenderEvents, type CliRenderer } from "../../renderer.js"
import { KeyEvent } from "../../lib/KeyHandler.js"
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
import { buildBindingKey, getErrorMessage, normalizeBindingInputs, normalizeKeyStroke } from "./lib/utils.js"
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

const keymapsByRenderer = new WeakMap<CliRenderer, Keymap>()
const NOOP = (): void => {}

type DiagnosticEvents = Pick<Events, "warning" | "error">

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
    emitError(message: string): void
  },
): () => void {
  const { kind, reservedFields, registeredFields, emitError } = options
  const entries = Object.entries(fields)
  const registered: Array<[string, T]> = []

  for (const [name] of entries) {
    if (reservedFields.has(name)) {
      emitError(`Keymap ${kind} field "${name}" is reserved`)
      continue
    }

    if (registeredFields.has(name)) {
      emitError(`Keymap ${kind} field "${name}" is already registered`)
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

export class Keymap {
  public readonly renderer: CliRenderer

  private readonly state = createKeymapState()
  private cleanedUp = false
  private readonly resources = new Map<symbol, { count: number; dispose: () => void }>()
  // Reuse `Emitter`, but keep its `onError` hook as a no-op so throwing error
  // listeners cannot re-enter `emitError` and loop forever.
  private events = new Emitter<DiagnosticEvents>(() => {})
  private hooks: Emitter<Hooks>
  private readonly notify: NotificationService
  private readonly runtime: RuntimeService
  private readonly conditions: ConditionService
  private readonly commands: CommandService
  private readonly projection: ProjectionService
  private readonly compiler: CompilerService
  private readonly dispatch: DispatchService
  private readonly layers: LayerService

  private readonly keypressListener: (event: KeyEvent) => void
  private readonly keyreleaseListener: (event: KeyEvent) => void
  private readonly rawListener: (sequence: string) => boolean
  private readonly focusedRenderableListener: (focused: Renderable | null) => void

  constructor(renderer: CliRenderer) {
    if (renderer.isDestroyed) {
      throw new Error("Cannot create a keymap for a destroyed renderer")
    }

    this.renderer = renderer
    this.hooks = new Emitter<Hooks>((name, error) => {
      this.notify.reportListenerError(name, error)
    })
    this.notify = new NotificationService(this.state, this.events, this.hooks)
    this.conditions = new ConditionService(this.state, this.notify)
    this.projection = new ProjectionService(this.state, this.renderer, this.hooks, this.notify, this.conditions)
    this.runtime = new RuntimeService(this.state, this.notify, this.conditions, this.projection)
    this.commands = new CommandService(this.state, this.notify, this.runtime, this.projection, this.hooks, {
      keymap: this,
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
      rootTarget: this.renderer.root,
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

  public getActiveKeys(options?: ActiveKeyOptions): readonly ActiveKey[] {
    return this.projection.getActiveKeys(options)
  }

  public getCommands(query?: CommandQuery): readonly CommandRecord[] {
    return this.projection.getCommands(query)
  }

  public normalizeCommandName(name: string): string {
    return this.commands.normalizeCommandName(name)
  }

  public normalizeBindings(bindings: Bindings): BindingInput[] {
    return normalizeBindingInputs(bindings)
  }

  public acquireResource(key: symbol, setup: () => () => void): () => void {
    if (this.cleanedUp || this.renderer.isDestroyed) {
      throw new Error("Cannot use a keymap after its renderer was destroyed")
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

  public prependBindingTransformer(transformer: BindingTransformer): () => void {
    return this.state.config.bindingTransformers.prepend(transformer)
  }

  public appendBindingTransformer(transformer: BindingTransformer): () => void {
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
      this.emitError(getErrorMessage(error, "Failed to register keymap token"), error)
      return NOOP
    }

    if (this.state.config.tokens.has(normalizedToken)) {
      this.emitError(`Keymap token "${normalizedToken}" is already registered`)
      return NOOP
    }

    let parsedToken: KeySequencePart

    try {
      parsedToken = this.compiler.parseTokenKey(token.key)
    } catch (error) {
      this.emitError(getErrorMessage(error, `Failed to register keymap token "${normalizedToken}"`), error)
      return NOOP
    }

    const registeredToken: ResolvedKeyToken = {
      stroke: parsedToken.stroke,
      matchKey: parsedToken.matchKey,
    }

    const nextTokens = new Map(this.state.config.tokens)
    nextTokens.set(normalizedToken, registeredToken)

    try {
      this.applyTokenState(nextTokens)
    } catch (error) {
      this.emitError(getErrorMessage(error, `Failed to register keymap token "${normalizedToken}"`), error)
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
          this.emitError(getErrorMessage(error, `Failed to unregister keymap token "${normalizedToken}"`), error)
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

  public prependCommandResolver(resolver: CommandResolver): () => void {
    return this.commands.prependCommandResolver(resolver)
  }

  public appendCommandResolver(resolver: CommandResolver): () => void {
    return this.commands.appendCommandResolver(resolver)
  }

  public clearCommandResolvers(): void {
    this.commands.clearCommandResolvers()
  }

  public prependLayerAnalyzer(analyzer: LayerAnalyzer): () => void {
    return this.state.config.layerAnalyzers.prepend(analyzer)
  }

  public appendLayerAnalyzer(analyzer: LayerAnalyzer): () => void {
    return this.state.config.layerAnalyzers.append(analyzer)
  }

  public clearLayerAnalyzers(): void {
    this.state.config.layerAnalyzers.clear()
  }

  public prependEventMatchResolver(resolver: EventMatchResolver): () => void {
    return this.state.config.eventMatchResolvers.prepend(resolver)
  }

  public appendEventMatchResolver(resolver: EventMatchResolver): () => void {
    return this.state.config.eventMatchResolvers.append(resolver)
  }

  public clearEventMatchResolvers(): void {
    this.state.config.eventMatchResolvers.clear()
  }

  private handleFocusedRenderableChange(_focused: Renderable | null): void {
    this.runWithStateChangeBatch(() => {
      // Any focus change breaks a pending sequence. Prefix dispatch is captured
      // against the state that started it, and changing focus can change the
      // active bindings and their precedence.
      this.projection.setPendingSequence(null)
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

  private applyTokenState(nextTokens: Map<string, ResolvedKeyToken>): void {
    this.layers.applyTokenState(nextTokens)
  }

  private warnOnce(key: string, message: string): void {
    this.notify.warnOnce(key, message)
  }

  private warnUnknownField(kind: "binding" | "layer", fieldName: string): void {
    this.warnOnce(`${kind}:${fieldName}`, `[Keymap] Unknown ${kind} field "${fieldName}" was ignored`)
  }

  private warnUnknownToken(token: string, sequence: string): void {
    this.warnOnce(`token:${token}`, `[Keymap] Unknown token "${token}" in key sequence "${sequence}" was ignored`)
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

export function getKeymap(renderer: CliRenderer): Keymap {
  if (renderer.isDestroyed) {
    throw new Error("Cannot create a keymap for a destroyed renderer")
  }

  const existing = keymapsByRenderer.get(renderer)
  if (existing) {
    return existing
  }

  const keymap = new Keymap(renderer)
  keymapsByRenderer.set(renderer, keymap)

  renderer.once(CliRenderEvents.DESTROY, () => {
    keymapsByRenderer.delete(renderer)
  })

  return keymap
}
