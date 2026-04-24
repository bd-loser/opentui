import type { CompilerService } from "./compiler.js"
import type { ActivationService } from "./activation.js"
import type { CommandExecutorService } from "./command-executor.js"
import type { CommandCatalogService } from "./command-catalog.js"
import type { ConditionService } from "./conditions.js"
import type { LayerService } from "./layers.js"
import type { NotificationService } from "./notify.js"
import type { RuntimeService } from "./runtime.js"
import type { State } from "./state.js"
import { cloneKeySequence, cloneKeyStroke, stringifyKeySequence } from "./keys.js"
import type {
  ActiveBinding,
  ActiveKey,
  EventMatchResolverContext,
  EventMatchResolver,
  KeyDeferredDisambiguationContext,
  KeyDeferredDisambiguationDecision,
  KeyDeferredDisambiguationHandler,
  KeyDisambiguationContext,
  KeyDisambiguationDecision,
  KeyDisambiguationResolver,
  KeyMatch,
  KeyInterceptOptions,
  KeyInputContext,
  KeymapEvent,
  PendingSequenceCapture,
  PendingSequenceState,
  RawInterceptOptions,
  RawInputContext,
  CompiledBinding,
  RegisteredLayer,
  SequenceNode,
} from "../types.js"

const DISAMBIGUATION_DECISION = Symbol("keymap-disambiguation-decision")
const DEFERRED_DISAMBIGUATION_DECISION = Symbol("keymap-deferred-disambiguation-decision")

type SyncDecisionAction = "run-exact" | "continue-sequence" | "clear" | "defer"
type DeferredDecisionAction = "run-exact" | "continue-sequence" | "clear"

interface InternalDisambiguationDecision {
  readonly [DISAMBIGUATION_DECISION]: true
  readonly action: SyncDecisionAction
  readonly handler?: KeyDeferredDisambiguationHandler<any, any>
}

interface InternalDeferredDisambiguationDecision {
  readonly [DEFERRED_DISAMBIGUATION_DECISION]: true
  readonly action: DeferredDecisionAction
}

interface PendingDisambiguation<TTarget extends object, TEvent extends KeymapEvent> {
  id: number
  controller: AbortController
  captures: readonly PendingSequenceCapture<TTarget, TEvent>[]
  apply: (decision: InternalDeferredDisambiguationDecision | void) => void
}

function createSyncDecision(
  action: SyncDecisionAction,
  handler?: KeyDeferredDisambiguationHandler<any, any>,
): KeyDisambiguationDecision {
  return {
    [DISAMBIGUATION_DECISION]: true,
    action,
    handler,
  } as unknown as KeyDisambiguationDecision
}

function createDeferredDecision(action: DeferredDecisionAction): KeyDeferredDisambiguationDecision {
  return {
    [DEFERRED_DISAMBIGUATION_DECISION]: true,
    action,
  } as unknown as KeyDeferredDisambiguationDecision
}

function isSyncDecision(value: unknown): value is InternalDisambiguationDecision {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { [DISAMBIGUATION_DECISION]?: unknown })[DISAMBIGUATION_DECISION] === true &&
    (value as { action?: unknown }).action !== undefined
  )
}

function isDeferredDecision(value: unknown): value is InternalDeferredDisambiguationDecision {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { [DEFERRED_DISAMBIGUATION_DECISION]?: unknown })[DEFERRED_DISAMBIGUATION_DECISION] === true &&
    (value as { action?: unknown }).action !== undefined
  )
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof value === "object" && typeof (value as PromiseLike<unknown>).then === "function"
}

function isSameCaptureList<TTarget extends object, TEvent extends KeymapEvent>(
  left: readonly PendingSequenceCapture<TTarget, TEvent>[],
  right: readonly PendingSequenceCapture<TTarget, TEvent>[],
): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftCapture = left[index]
    const rightCapture = right[index]
    if (
      !leftCapture ||
      !rightCapture ||
      leftCapture.layer !== rightCapture.layer ||
      leftCapture.node !== rightCapture.node
    ) {
      return false
    }
  }

  return true
}

export class DispatchService<TTarget extends object, TEvent extends KeymapEvent> {
  private readonly eventMatchResolverContext: EventMatchResolverContext
  private pendingDisambiguation: PendingDisambiguation<TTarget, TEvent> | null = null
  private nextPendingDisambiguationId = 0

  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly notify: NotificationService<TTarget, TEvent>,
    private readonly runtime: RuntimeService<TTarget, TEvent>,
    private readonly activation: ActivationService<TTarget, TEvent>,
    private readonly conditions: ConditionService<TTarget, TEvent>,
    private readonly executor: CommandExecutorService<TTarget, TEvent>,
    private readonly compiler: CompilerService<TTarget, TEvent>,
    private readonly catalog: CommandCatalogService<TTarget, TEvent>,
    private readonly layers: LayerService<TTarget, TEvent>,
  ) {
    this.eventMatchResolverContext = {
      resolveKey: (key) => {
        return this.compiler.parseTokenKey(key).match
      },
    }
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
      return this.state.dispatch.keyHooks.register(fn as (ctx: KeyInputContext<TEvent>) => void, {
        priority: keyOptions?.priority ?? 0,
        release: keyOptions?.release ?? false,
      })
    }

    const rawOptions = options as RawInterceptOptions | undefined
    return this.state.dispatch.rawHooks.register(fn as (ctx: RawInputContext) => void, {
      priority: rawOptions?.priority ?? 0,
    })
  }

  public prependEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void {
    return this.state.dispatch.eventMatchResolvers.prepend(resolver)
  }

  public appendEventMatchResolver(resolver: EventMatchResolver<TEvent>): () => void {
    return this.state.dispatch.eventMatchResolvers.append(resolver)
  }

  public clearEventMatchResolvers(): void {
    this.state.dispatch.eventMatchResolvers.clear()
  }

  public prependDisambiguationResolver(resolver: KeyDisambiguationResolver<TTarget, TEvent>): () => void {
    return this.mutateDisambiguationResolvers(
      () => this.state.dispatch.disambiguationResolvers.prepend(resolver as KeyDisambiguationResolver<any, TEvent>),
      resolver as KeyDisambiguationResolver<any, TEvent>,
    )
  }

  public appendDisambiguationResolver(resolver: KeyDisambiguationResolver<TTarget, TEvent>): () => void {
    return this.mutateDisambiguationResolvers(
      () => this.state.dispatch.disambiguationResolvers.append(resolver as KeyDisambiguationResolver<any, TEvent>),
      resolver as KeyDisambiguationResolver<any, TEvent>,
    )
  }

  public clearDisambiguationResolvers(): void {
    if (!this.state.dispatch.disambiguationResolvers.has()) {
      return
    }

    this.notify.runWithStateChangeBatch(() => {
      this.state.dispatch.disambiguationResolvers.clear()
      this.layers.recompileBindings()
    })
  }

  public handlePendingSequenceChange(
    _previous: PendingSequenceState<TTarget, TEvent> | null,
    next: PendingSequenceState<TTarget, TEvent> | null,
  ): void {
    const pending = this.pendingDisambiguation
    if (!pending) {
      return
    }

    if (next && isSameCaptureList(pending.captures, next.captures)) {
      return
    }

    this.cancelPendingDisambiguation()
  }

  public handleRawSequence(sequence: string): boolean {
    const hooks = this.state.dispatch.rawHooks.entries()
    if (hooks.length === 0) {
      return false
    }

    let stopped = false
    const context: RawInputContext = {
      sequence,
      stop() {
        stopped = true
      },
    }

    for (const hook of hooks) {
      try {
        hook.listener(context)
      } catch (error) {
        this.notify.emitError("raw-intercept-error", error, "[Keymap] Error in raw intercept listener:")
      }

      if (stopped) {
        return true
      }
    }

    return false
  }

  public handleKeyEvent(event: TEvent, release: boolean): void {
    if (!release) {
      this.cancelPendingDisambiguation()
    }

    const hooks = this.state.dispatch.keyHooks.entries()
    const context: KeyInputContext<TEvent> = {
      event,
      setData: (name, value) => {
        this.runtime.setData(name, value)
      },
      getData: (name) => {
        return this.runtime.getData(name)
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
        hook.listener(context)
      } catch (error) {
        this.notify.emitError("key-intercept-error", error, "[Keymap] Error in key intercept listener:")
      }

      if (event.propagationStopped) {
        return
      }
    }

    if (release) {
      this.dispatchReleaseLayers(event)
      return
    }

    this.dispatchLayers(event)
  }

  private mutateDisambiguationResolvers(
    register: () => () => void,
    resolver: KeyDisambiguationResolver<any, TEvent>,
  ): () => void {
    return this.notify.runWithStateChangeBatch(() => {
      const hadResolvers = this.state.dispatch.disambiguationResolvers.has()
      const off = register()

      if (!hadResolvers && this.state.dispatch.disambiguationResolvers.has()) {
        this.layers.recompileBindings()
      }

      return () => {
        this.notify.runWithStateChangeBatch(() => {
          const hadBeforeRemoval = this.state.dispatch.disambiguationResolvers.has()
          off()

          if (this.state.dispatch.disambiguationResolvers.values().includes(resolver)) {
            return
          }

          if (hadBeforeRemoval && !this.state.dispatch.disambiguationResolvers.has()) {
            this.layers.recompileBindings()
          }
        })
      }
    })
  }

  private dispatchReleaseLayers(event: TEvent): void {
    const focused = this.activation.getFocusedTarget()
    const activeLayers = this.activation.getActiveLayers(focused)
    const hasLayerConditions = this.state.layers.layersWithConditions > 0
    const matchKeys = this.resolveEventMatchKeys(event)

    layerLoop: for (const layer of activeLayers) {
      if (layer.compiledBindings.length === 0) {
        continue
      }

      if (hasLayerConditions && !this.conditions.hasNoConditions(layer) && !this.conditions.matchesConditions(layer)) {
        continue
      }

      for (const strokeKey of matchKeys) {
        const result = this.runReleaseBindings(layer, strokeKey, event, focused)
        if (!result.handled) {
          continue
        }

        if (result.stop) {
          return
        }

        continue layerLoop
      }
    }
  }

  private dispatchLayers(event: TEvent): void {
    const focused = this.activation.getFocusedTarget()
    const pending = this.activation.ensureValidPendingSequence()
    const matchKeys = this.resolveEventMatchKeys(event)

    if (pending) {
      this.dispatchPendingSequence(pending, matchKeys, event, focused)
      return
    }

    const activeLayers = this.activation.getActiveLayers(focused)
    this.dispatchFromRoot(activeLayers, matchKeys, event, focused)
  }

  private dispatchPendingSequence(
    pending: PendingSequenceState<TTarget, TEvent>,
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
  ): void {
    const advancedCaptures: PendingSequenceCapture<TTarget, TEvent>[] = []

    for (const capture of pending.captures) {
      const nextNode = this.getReachableChild(capture.node, matchKeys, focused)
      if (!nextNode) {
        continue
      }

      advancedCaptures.push({
        layer: capture.layer,
        node: nextNode,
      })
    }

    if (advancedCaptures.length === 0) {
      this.activation.setPendingSequence(null)
      return
    }

    this.dispatchPendingCapturesFromIndex(advancedCaptures, 0, false, event, focused)
  }

  private dispatchPendingCapturesFromIndex(
    advancedCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    startIndex: number,
    handledExact: boolean,
    event: TEvent,
    focused: TTarget | null,
  ): void {
    let hasHandledExact = handledExact

    for (let index = startIndex; index < advancedCaptures.length; index += 1) {
      const capture = advancedCaptures[index]
      if (!capture) {
        continue
      }

      if (capture.node.children.size > 0) {
        if (hasHandledExact) {
          continue
        }

        const continuationCaptures = this.collectPendingCapturesFromAdvanced(advancedCaptures, index)
        if (
          this.tryResolvePendingAmbiguity(
            advancedCaptures,
            index,
            continuationCaptures,
            capture,
            event,
            focused,
            hasHandledExact,
          )
        ) {
          return
        }

        this.activation.setPendingSequence({ captures: continuationCaptures })
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const result = this.runBindings(capture.layer, capture.node.bindings, event, focused)
      if (!result.handled) {
        continue
      }

      hasHandledExact = true
      if (result.stop) {
        this.activation.setPendingSequence(null)
        return
      }
    }

    this.activation.setPendingSequence(null)
  }

  private dispatchFromRoot(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
  ): void {
    this.dispatchFromRootAtIndex(activeLayers, 0, matchKeys, event, focused)
  }

  private dispatchFromRootAtIndex(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    startIndex: number,
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
  ): void {
    const hasLayerConditions = this.state.layers.layersWithConditions > 0

    for (let index = startIndex; index < activeLayers.length; index += 1) {
      const layer = activeLayers[index]
      if (!layer) {
        continue
      }

      if (layer.root.children.size === 0) {
        continue
      }

      if (hasLayerConditions && !this.conditions.hasNoConditions(layer) && !this.conditions.matchesConditions(layer)) {
        continue
      }

      const nextNode = this.getReachableChild(layer.root, matchKeys, focused)
      if (!nextNode) {
        continue
      }

      if (nextNode.children.size > 0) {
        const continuationCaptures = this.collectPendingCapturesFromRoot(activeLayers, index, matchKeys, focused)
        if (
          this.tryResolveRootAmbiguity(
            activeLayers,
            index,
            matchKeys,
            continuationCaptures,
            layer,
            nextNode,
            event,
            focused,
          )
        ) {
          return
        }

        this.activation.setPendingSequence({ captures: continuationCaptures })
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

  private tryResolveRootAmbiguity(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    layerIndex: number,
    matchKeys: readonly KeyMatch[],
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    layer: RegisteredLayer<TTarget, TEvent>,
    node: SequenceNode<TTarget, TEvent>,
    event: TEvent,
    focused: TTarget | null,
  ): boolean {
    if (!this.state.dispatch.disambiguationResolvers.has() || continuationCaptures.length === 0) {
      return false
    }

    const activeView = this.catalog.getActiveCommandView(focused)
    const exactBindings = this.activation.collectMatchingBindings(node.bindings, focused, activeView)
    if (!exactBindings.some((binding) => binding.command !== undefined)) {
      return false
    }

    const applyContinue = (): void => {
      this.activation.setPendingSequence({ captures: continuationCaptures })
      event.preventDefault()
      event.stopPropagation()
    }

    const applyClear = (): void => {
      this.activation.setPendingSequence(null)
      event.preventDefault()
      event.stopPropagation()
    }

    const applyExact = (): void => {
      this.activation.setPendingSequence(null)
      const result = this.runBindings(layer, node.bindings, event, focused)
      if (!result.stop) {
        this.dispatchFromRootAtIndex(activeLayers, layerIndex + 1, matchKeys, event, focused)
      }
    }

    const sequence = this.activation.collectSequencePartsFromPending({ captures: continuationCaptures })
    const decision = this.resolveDisambiguation({
      event,
      focused,
      sequence,
      exactBindings,
      continuationCaptures,
      activeView,
    })

    if (!decision) {
      this.warnUnresolvedAmbiguity(sequence)
      applyContinue()
      return true
    }

    return this.applySyncDecision(
      decision,
      continuationCaptures,
      applyExact,
      applyContinue,
      applyClear,
      focused,
      sequence,
    )
  }

  private tryResolvePendingAmbiguity(
    advancedCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    captureIndex: number,
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    capture: PendingSequenceCapture<TTarget, TEvent>,
    event: TEvent,
    focused: TTarget | null,
    handledExact: boolean,
  ): boolean {
    if (!this.state.dispatch.disambiguationResolvers.has() || continuationCaptures.length === 0) {
      return false
    }

    const activeView = this.catalog.getActiveCommandView(focused)
    const exactBindings = this.activation.collectMatchingBindings(capture.node.bindings, focused, activeView)
    if (!exactBindings.some((binding) => binding.command !== undefined)) {
      return false
    }

    const applyContinue = (): void => {
      this.activation.setPendingSequence({ captures: continuationCaptures })
      event.preventDefault()
      event.stopPropagation()
    }

    const applyClear = (): void => {
      this.activation.setPendingSequence(null)
      event.preventDefault()
      event.stopPropagation()
    }

    const applyExact = (): void => {
      this.activation.setPendingSequence(null)
      const result = this.runBindings(capture.layer, capture.node.bindings, event, focused)
      if (result.stop) {
        return
      }

      this.dispatchPendingCapturesFromIndex(
        advancedCaptures,
        captureIndex + 1,
        handledExact || result.handled,
        event,
        focused,
      )
    }

    const sequence = this.activation.collectSequencePartsFromPending({ captures: continuationCaptures })
    const decision = this.resolveDisambiguation({
      event,
      focused,
      sequence,
      exactBindings,
      continuationCaptures,
      activeView,
    })

    if (!decision) {
      this.warnUnresolvedAmbiguity(sequence)
      applyContinue()
      return true
    }

    return this.applySyncDecision(
      decision,
      continuationCaptures,
      applyExact,
      applyContinue,
      applyClear,
      focused,
      sequence,
    )
  }

  private applySyncDecision(
    decision: InternalDisambiguationDecision,
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    runExact: () => void,
    continueSequence: () => void,
    clear: () => void,
    focused: TTarget | null,
    sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>,
  ): boolean {
    if (decision.action === "run-exact") {
      runExact()
      return true
    }

    if (decision.action === "continue-sequence") {
      continueSequence()
      return true
    }

    if (decision.action === "clear") {
      clear()
      return true
    }

    continueSequence()
    this.scheduleDeferredDisambiguation(continuationCaptures, decision.handler!, focused, sequence, (nextDecision) => {
      if (!nextDecision) {
        return
      }

      if (nextDecision.action === "run-exact") {
        runExact()
        return
      }

      if (nextDecision.action === "continue-sequence") {
        continueSequence()
        return
      }

      clear()
    })
    return true
  }

  private resolveDisambiguation(options: {
    event: TEvent
    focused: TTarget | null
    sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>
    exactBindings: readonly CompiledBinding<TTarget, TEvent>[]
    continuationCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[]
    activeView: ReturnType<CommandCatalogService<TTarget, TEvent>["getActiveCommandView"]>
  }): InternalDisambiguationDecision | undefined {
    const exact = this.activation.collectActiveBindings(options.exactBindings, options.focused, options.activeView)
    const continuations = this.activation.getActiveKeysForCaptures(options.continuationCaptures, {
      includeBindings: true,
      includeMetadata: true,
    })
    const stroke = options.sequence.at(-1)
    if (!stroke) {
      return undefined
    }

    const ctx: KeyDisambiguationContext<TTarget, TEvent> = {
      event: options.event as Readonly<Omit<TEvent, "preventDefault" | "stopPropagation">>,
      focused: options.focused,
      sequence: cloneKeySequence(options.sequence),
      stroke: {
        ...stroke,
        stroke: cloneKeyStroke(stroke.stroke),
      },
      exact: exact.map((binding) => ({
        ...binding,
        sequence: cloneKeySequence(binding.sequence),
      })) as readonly ActiveBinding<TTarget, TEvent>[],
      continuations: continuations as readonly ActiveKey<TTarget, TEvent>[],
      getData: (name) => {
        return this.runtime.getData(name)
      },
      setData: (name, value) => {
        this.runtime.setData(name, value)
      },
      runExact: () => createSyncDecision("run-exact"),
      continueSequence: () => createSyncDecision("continue-sequence"),
      clear: () => createSyncDecision("clear"),
      defer: (run) => createSyncDecision("defer", run),
    }

    for (const resolver of this.state.dispatch.disambiguationResolvers.values()) {
      let result: KeyDisambiguationDecision | undefined

      try {
        result = (resolver as KeyDisambiguationResolver<TTarget, TEvent>)(ctx)
      } catch (error) {
        this.notify.emitError("disambiguation-resolver-error", error, "[Keymap] Error in disambiguation resolver:")
        continue
      }

      if (result === undefined) {
        continue
      }

      if (isPromiseLike(result)) {
        this.notify.emitError(
          "invalid-disambiguation-resolver-return",
          result,
          "[Keymap] Disambiguation resolvers must return synchronously; use ctx.defer(...) for async handling",
        )
        continue
      }

      if (!isSyncDecision(result)) {
        this.notify.emitError(
          "invalid-disambiguation-decision",
          result,
          "[Keymap] Invalid disambiguation decision returned by resolver:",
        )
        continue
      }

      return result
    }

    return undefined
  }

  private scheduleDeferredDisambiguation(
    captures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    handler: KeyDeferredDisambiguationHandler<TTarget, TEvent>,
    focused: TTarget | null,
    sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>,
    apply: (decision: InternalDeferredDisambiguationDecision | void) => void,
  ): void {
    this.cancelPendingDisambiguation()

    const controller = new AbortController()
    const pending: PendingDisambiguation<TTarget, TEvent> = {
      id: this.nextPendingDisambiguationId++,
      controller,
      captures,
      apply,
    }
    this.pendingDisambiguation = pending

    queueMicrotask(() => {
      this.executeDeferredDisambiguation(pending, handler, focused, sequence)
    })
  }

  private executeDeferredDisambiguation(
    pending: PendingDisambiguation<TTarget, TEvent>,
    handler: KeyDeferredDisambiguationHandler<TTarget, TEvent>,
    focused: TTarget | null,
    sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>,
  ): void {
    if (!this.isPendingDisambiguationCurrent(pending)) {
      return
    }

    const ctx: KeyDeferredDisambiguationContext<TTarget, TEvent> = {
      signal: pending.controller.signal,
      sequence: cloneKeySequence(sequence),
      focused,
      sleep: (ms) => {
        return this.sleepWithSignal(ms, pending.controller.signal)
      },
      runExact: () => createDeferredDecision("run-exact"),
      continueSequence: () => createDeferredDecision("continue-sequence"),
      clear: () => createDeferredDecision("clear"),
    }

    let result: KeyDeferredDisambiguationDecision | void | Promise<KeyDeferredDisambiguationDecision | void>
    try {
      result = handler(ctx)
    } catch (error) {
      if (this.isPendingDisambiguationCurrent(pending)) {
        this.notify.emitError(
          "deferred-disambiguation-error",
          error,
          "[Keymap] Error in deferred disambiguation handler:",
        )
        this.finishPendingDisambiguation(pending)
      }
      return
    }

    if (isPromiseLike(result)) {
      result
        .then((resolved) => {
          this.applyDeferredDisambiguationResult(pending, resolved)
        })
        .catch((error) => {
          if (!this.isPendingDisambiguationCurrent(pending)) {
            return
          }

          this.notify.emitError(
            "deferred-disambiguation-error",
            error,
            "[Keymap] Error in deferred disambiguation handler:",
          )
          this.finishPendingDisambiguation(pending)
        })
      return
    }

    this.applyDeferredDisambiguationResult(pending, result)
  }

  private applyDeferredDisambiguationResult(
    pending: PendingDisambiguation<TTarget, TEvent>,
    result: KeyDeferredDisambiguationDecision | void,
  ): void {
    if (!this.isPendingDisambiguationCurrent(pending)) {
      return
    }

    if (result !== undefined && !isDeferredDecision(result)) {
      this.notify.emitError(
        "invalid-deferred-disambiguation-decision",
        result,
        "[Keymap] Invalid deferred disambiguation decision returned by handler:",
      )
      this.finishPendingDisambiguation(pending)
      return
    }

    this.finishPendingDisambiguation(pending)
    pending.apply(result as InternalDeferredDisambiguationDecision | void)
  }

  private finishPendingDisambiguation(pending: PendingDisambiguation<TTarget, TEvent>): void {
    if (!this.isPendingDisambiguationCurrent(pending)) {
      return
    }

    this.pendingDisambiguation = null
  }

  private cancelPendingDisambiguation(): void {
    const pending = this.pendingDisambiguation
    if (!pending) {
      return
    }

    this.pendingDisambiguation = null
    pending.controller.abort()
  }

  private isPendingDisambiguationCurrent(pending: PendingDisambiguation<TTarget, TEvent>): boolean {
    return this.pendingDisambiguation === pending
  }

  private sleepWithSignal(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
      return Promise.resolve(false)
    }

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(
        () => {
          signal.removeEventListener("abort", onAbort)
          resolve(true)
        },
        Math.max(0, ms),
      )

      const onAbort = () => {
        clearTimeout(timeout)
        signal.removeEventListener("abort", onAbort)
        resolve(false)
      }

      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  private warnUnresolvedAmbiguity(
    sequence: ReturnType<ActivationService<TTarget, TEvent>["collectSequencePartsFromPending"]>,
  ): void {
    const display = stringifyKeySequence(sequence, { preferDisplay: true })

    this.notify.warnOnce(
      `unresolved-disambiguation:${display}`,
      "unresolved-disambiguation",
      { sequence: display },
      `[Keymap] Ambiguous exact/prefix sequence "${display}" fell back to prefix handling because no disambiguation resolver resolved it`,
    )
  }

  private collectPendingCapturesFromRoot(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    startIndex: number,
    matchKeys: readonly KeyMatch[],
    focused: TTarget | null,
  ): PendingSequenceCapture<TTarget, TEvent>[] {
    const captures: PendingSequenceCapture<TTarget, TEvent>[] = []
    const hasLayerConditions = this.state.layers.layersWithConditions > 0

    for (let index = startIndex; index < activeLayers.length; index += 1) {
      const layer = activeLayers[index]
      if (!layer || layer.root.children.size === 0) {
        continue
      }

      if (hasLayerConditions && !this.conditions.hasNoConditions(layer) && !this.conditions.matchesConditions(layer)) {
        continue
      }

      const nextNode = this.getReachableChild(layer.root, matchKeys, focused)
      if (!nextNode || nextNode.children.size === 0) {
        continue
      }

      captures.push({
        layer,
        node: nextNode,
      })
    }

    return captures
  }

  private collectPendingCapturesFromAdvanced(
    advancedCaptures: readonly PendingSequenceCapture<TTarget, TEvent>[],
    startIndex: number,
  ): PendingSequenceCapture<TTarget, TEvent>[] {
    return advancedCaptures.filter((candidate, candidateIndex) => {
      return candidateIndex >= startIndex && candidate.node.children.size > 0
    })
  }

  private resolveEventMatchKeys(event: TEvent): KeyMatch[] {
    const resolvers = this.state.dispatch.eventMatchResolvers.values()

    if (resolvers.length === 0) {
      return []
    }

    if (resolvers.length === 1) {
      return resolveSingleEventMatchKeys(resolvers[0]!, event, this.eventMatchResolverContext, this.notify)
    }

    const keys: KeyMatch[] = []
    const seen = new Set<KeyMatch>()

    for (const resolver of resolvers) {
      let resolved: readonly KeyMatch[] | undefined

      try {
        resolved = resolver(event, this.eventMatchResolverContext)
      } catch (error) {
        this.notify.emitError("event-match-resolver-error", error, "[Keymap] Error in event match resolver:")
        continue
      }

      if (!resolved || resolved.length === 0) {
        continue
      }

      for (const candidate of resolved) {
        if (typeof candidate !== "symbol") {
          this.notify.emitError(
            "invalid-event-match-resolver-candidate",
            candidate,
            "[Keymap] Invalid event match resolver candidate:",
          )
          continue
        }

        if (seen.has(candidate)) {
          continue
        }

        seen.add(candidate)
        keys.push(candidate)
      }
    }

    return keys
  }

  private runReleaseBindings(
    layer: RegisteredLayer<TTarget, TEvent>,
    strokeKey: KeyMatch,
    event: TEvent,
    focused: TTarget | null,
  ): { handled: boolean; stop: boolean } {
    let handled = false

    for (const binding of layer.compiledBindings) {
      if (binding.event !== "release") {
        continue
      }

      const firstPart = binding.sequence[0]
      if (!firstPart || firstPart.match !== strokeKey) {
        continue
      }

      if (!this.conditions.matchesConditions(binding)) {
        continue
      }

      const bindingHandled = this.executor.runBinding(layer, binding, event, focused)
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

  private getReachableChild(
    node: SequenceNode<TTarget, TEvent>,
    matchKeys: readonly KeyMatch[],
    focused: TTarget | null,
  ): SequenceNode<TTarget, TEvent> | undefined {
    for (const strokeKey of matchKeys) {
      const child = node.children.get(strokeKey)
      if (!child || !this.activation.nodeHasReachableBindings(child, focused)) {
        continue
      }

      return child
    }

    return undefined
  }

  private runBindings(
    layer: RegisteredLayer<TTarget, TEvent>,
    bindings: CompiledBinding<TTarget, TEvent>[],
    event: TEvent,
    focused: TTarget | null,
  ): { handled: boolean; stop: boolean } {
    let handled = false

    for (const binding of bindings) {
      if (!this.conditions.matchesConditions(binding)) {
        continue
      }

      const bindingHandled = this.executor.runBinding(layer, binding, event, focused)
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
}

function resolveSingleEventMatchKeys<TTarget extends object, TEvent extends KeymapEvent>(
  resolver: EventMatchResolver<TEvent>,
  event: TEvent,
  ctx: EventMatchResolverContext,
  notify: NotificationService<TTarget, TEvent>,
): KeyMatch[] {
  let resolved: readonly KeyMatch[] | undefined
  try {
    resolved = resolver(event, ctx)
  } catch (error) {
    notify.emitError("event-match-resolver-error", error, "[Keymap] Error in event match resolver:")
    return []
  }

  if (!resolved || resolved.length === 0) {
    return []
  }

  if (resolved.length === 1) {
    const [candidate] = resolved
    if (typeof candidate !== "symbol") {
      notify.emitError(
        "invalid-event-match-resolver-candidate",
        candidate,
        "[Keymap] Invalid event match resolver candidate:",
      )
      return []
    }

    return [candidate]
  }

  const keys: KeyMatch[] = []
  const seen = new Set<KeyMatch>()
  for (const candidate of resolved) {
    if (typeof candidate !== "symbol") {
      notify.emitError(
        "invalid-event-match-resolver-candidate",
        candidate,
        "[Keymap] Invalid event match resolver candidate:",
      )
      continue
    }

    if (seen.has(candidate)) {
      continue
    }

    seen.add(candidate)
    keys.push(candidate)
  }

  return keys
}
