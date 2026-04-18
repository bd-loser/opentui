import { KeyEvent } from "../../../lib/KeyHandler.js"
import type { Renderable } from "../../../Renderable.js"
import type { CompilerService } from "./compiler.js"
import type { CommandService } from "./commands.js"
import type { ConditionService } from "./conditions.js"
import type { NotificationService } from "./notify.js"
import type { RuntimeService } from "./runtime.js"
import type { State } from "./state.js"
import type {
  EventMatchResolverContext,
  EventMatchResolver,
  KeyInputContext,
  RawInputContext,
  CompiledBinding,
  PendingSequenceState,
  RegisteredLayer,
  SequenceNode,
} from "../types.js"

export class DispatchService {
  private readonly eventMatchResolverContext: EventMatchResolverContext

  constructor(
    private readonly state: State,
    private readonly notify: NotificationService,
    private readonly runtime: RuntimeService,
    private readonly conditions: ConditionService,
    private readonly commands: CommandService,
    private readonly compiler: CompilerService,
  ) {
    this.eventMatchResolverContext = {
      matchKey: (key) => {
        return this.compiler.parseTokenKey(key).matchKey
      },
    }
  }

  public handleRawSequence(sequence: string): boolean {
    const hooks = this.state.config.rawHooks.entries()
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
        this.notify.emitError("[ActionMap] Error in raw intercept listener:", error)
      }

      if (stopped) {
        return true
      }
    }

    return false
  }

  public handleKeyEvent(event: KeyEvent, release: boolean): void {
    const hooks = this.state.config.keyHooks.entries()
    const context: KeyInputContext = {
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
        this.notify.emitError("[ActionMap] Error in key intercept listener:", error)
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

  private dispatchReleaseLayers(event: KeyEvent): void {
    const focused = this.runtime.getFocusedRenderable()
    const activeLayers = this.runtime.getActiveLayers(focused)
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

  private dispatchLayers(event: KeyEvent): void {
    const focused = this.runtime.getFocusedRenderable()
    const pending = this.runtime.ensureValidPendingSequence()
    const matchKeys = this.resolveEventMatchKeys(event)

    if (pending) {
      this.dispatchPendingSequence(pending, matchKeys, event, focused)
      return
    }

    const activeLayers = this.runtime.getActiveLayers(focused)
    this.dispatchFromRoot(activeLayers, matchKeys, event, focused)
  }

  private dispatchPendingSequence(
    pending: PendingSequenceState,
    matchKeys: readonly string[],
    event: KeyEvent,
    focused: Renderable | null,
  ): void {
    const nextNode = this.getReachableChild(pending.node, matchKeys, focused)
    if (!nextNode) {
      this.runtime.setPendingSequence(null)
      return
    }

    if (nextNode.children.size > 0) {
      this.runtime.setPendingSequence({
        layer: pending.layer,
        node: nextNode,
      })
      event.preventDefault()
      event.stopPropagation()
      return
    }

    this.runBindings(pending.layer, nextNode.bindings, event, focused)
    this.runtime.setPendingSequence(null)
  }

  private dispatchFromRoot(
    activeLayers: RegisteredLayer[],
    matchKeys: readonly string[],
    event: KeyEvent,
    focused: Renderable | null,
  ): void {
    const hasLayerConditions = this.state.layers.layersWithConditions > 0

    layerLoop: for (const layer of activeLayers) {
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
        this.runtime.setPendingSequence({
          layer,
          node: nextNode,
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

  private resolveEventMatchKeys(event: KeyEvent): string[] {
    const resolvers = this.state.config.eventMatchResolvers.values()

    if (resolvers.length === 0) {
      return []
    }

    if (resolvers.length === 1) {
      return resolveSingleEventMatchKeys(resolvers[0]!, event, this.eventMatchResolverContext, this.notify)
    }

    const keys: string[] = []
    const seen = new Set<string>()

    for (const resolver of resolvers) {
      let resolved: readonly string[] | undefined

      try {
        resolved = resolver(event, this.eventMatchResolverContext)
      } catch (error) {
        this.notify.emitError("[ActionMap] Error in event match resolver:", error)
        continue
      }

      if (!resolved || resolved.length === 0) {
        continue
      }

      for (const candidate of resolved) {
        if (typeof candidate !== "string") {
          this.notify.emitError("[ActionMap] Invalid event match resolver candidate:", candidate)
          continue
        }

        if (!candidate || seen.has(candidate)) {
          continue
        }

        seen.add(candidate)
        keys.push(candidate)
      }
    }

    return keys
  }

  private runReleaseBindings(
    layer: RegisteredLayer,
    strokeKey: string,
    event: KeyEvent,
    focused: Renderable | null,
  ): { handled: boolean; stop: boolean } {
    let handled = false

    for (const binding of layer.compiledBindings) {
      if (binding.event !== "release") {
        continue
      }

      const firstPart = binding.sequence[0]
      if (!firstPart || firstPart.matchKey !== strokeKey) {
        continue
      }

      if (!this.conditions.matchesConditions(binding)) {
        continue
      }

      const bindingHandled = this.commands.runBinding(layer, binding, event, focused)
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
    node: SequenceNode,
    matchKeys: readonly string[],
    focused: Renderable | null,
  ): SequenceNode | undefined {
    for (const strokeKey of matchKeys) {
      const child = node.children.get(strokeKey)
      if (!child || !this.runtime.nodeHasReachableBindings(child, focused)) {
        continue
      }

      return child
    }

    return undefined
  }

  private runBindings(
    layer: RegisteredLayer,
    bindings: CompiledBinding[],
    event: KeyEvent,
    focused: Renderable | null,
  ): { handled: boolean; stop: boolean } {
    let handled = false

    for (const binding of bindings) {
      if (!this.conditions.matchesConditions(binding)) {
        continue
      }

      const bindingHandled = this.commands.runBinding(layer, binding, event, focused)
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

function resolveSingleEventMatchKeys(
  resolver: EventMatchResolver,
  event: KeyEvent,
  ctx: EventMatchResolverContext,
  notify: NotificationService,
): string[] {
  let resolved: readonly string[] | undefined
  try {
    resolved = resolver(event, ctx)
  } catch (error) {
    notify.emitError("[ActionMap] Error in event match resolver:", error)
    return []
  }

  if (!resolved || resolved.length === 0) {
    return []
  }

  if (resolved.length === 1) {
    const [candidate] = resolved
    if (typeof candidate !== "string" || !candidate) {
      notify.emitError("[ActionMap] Invalid event match resolver candidate:", candidate)
      return []
    }

    return [candidate]
  }

  const keys: string[] = []
  const seen = new Set<string>()
  for (const candidate of resolved) {
    if (typeof candidate !== "string") {
      notify.emitError("[ActionMap] Invalid event match resolver candidate:", candidate)
      continue
    }

    if (!candidate || seen.has(candidate)) {
      continue
    }

    seen.add(candidate)
    keys.push(candidate)
  }

  return keys
}
