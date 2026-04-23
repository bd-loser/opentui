import type { CompilerService } from "./compiler.js"
import type { ActivationService } from "./activation.js"
import type { CommandExecutorService } from "./command-executor.js"
import type { ConditionService } from "./conditions.js"
import type { NotificationService } from "./notify.js"
import type { RuntimeService } from "./runtime.js"
import type { State } from "./state.js"
import type {
  EventMatchResolverContext,
  EventMatchResolver,
  KeyMatch,
  KeyInterceptOptions,
  KeyInputContext,
  KeymapEvent,
  PendingSequenceCapture,
  RawInterceptOptions,
  RawInputContext,
  CompiledBinding,
  PendingSequenceState,
  RegisteredLayer,
  SequenceNode,
} from "../types.js"

export class DispatchService<TTarget extends object, TEvent extends KeymapEvent> {
  private readonly eventMatchResolverContext: EventMatchResolverContext

  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly notify: NotificationService<TTarget, TEvent>,
    private readonly runtime: RuntimeService<TTarget, TEvent>,
    private readonly activation: ActivationService<TTarget, TEvent>,
    private readonly conditions: ConditionService<TTarget, TEvent>,
    private readonly executor: CommandExecutorService<TTarget, TEvent>,
    private readonly compiler: CompilerService<TTarget, TEvent>,
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

    let handledExact = false

    captureLoop: for (let index = 0; index < advancedCaptures.length; index += 1) {
      const capture = advancedCaptures[index]
      if (!capture) {
        continue
      }

      if (capture.node.children.size > 0) {
        if (handledExact) {
          continue
        }

        this.activation.setPendingSequence({
          captures: advancedCaptures.filter((candidate, candidateIndex) => {
            return candidateIndex >= index && candidate.node.children.size > 0
          }),
        })
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const result = this.runBindings(capture.layer, capture.node.bindings, event, focused)
      if (!result.handled) {
        continue
      }

      handledExact = true
      if (result.stop) {
        this.activation.setPendingSequence(null)
        return
      }

      continue captureLoop
    }

    this.activation.setPendingSequence(null)
  }

  private dispatchFromRoot(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    matchKeys: readonly KeyMatch[],
    event: TEvent,
    focused: TTarget | null,
  ): void {
    const hasLayerConditions = this.state.layers.layersWithConditions > 0

    layerLoop: for (let index = 0; index < activeLayers.length; index += 1) {
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
        this.activation.setPendingSequence({
          captures: this.collectPendingCapturesFromRoot(activeLayers, index, matchKeys, focused),
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

      continue layerLoop
    }
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
