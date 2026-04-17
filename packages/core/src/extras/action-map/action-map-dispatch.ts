import { KeyEvent } from "../../lib/KeyHandler.js"
import type { ActionMap } from "./action-map.js"
import type { ActionMapConditions } from "./action-map-conditions.js"
import type { ActionMapLayers } from "./action-map-layers.js"
import type { ActionMapNotifier } from "./action-map-notify.js"
import type { ActionMapProjections } from "./action-map-projections.js"
import type { ActionMapRuntime } from "./action-map-runtime.js"
import type { ActionMapState } from "./action-map-state.js"
import type {
  ActionMapCommandContext,
  ActionMapCommandResult,
  ActionMapEventMatchResolver,
  ActionMapKeyInputContext,
  ActionMapRawInputContext,
  CompiledBinding,
  PendingSequenceState,
  RegisteredLayer,
  RuntimeMatchable,
  SequenceNode,
} from "./types.js"
import { isPromiseLike } from "./utils.js"

export class ActionMapDispatch {
  constructor(
    private readonly state: ActionMapState,
    private readonly notify: ActionMapNotifier,
    private readonly actionMap: ActionMap,
    private readonly runtime: Pick<ActionMapRuntime, "getFocusedRenderable">,
    private readonly layers: Pick<ActionMapLayers, "getActiveLayers">,
    private readonly projections: Pick<ActionMapProjections, "ensureValidPendingSequence" | "nodeHasReachableBindings">,
    private readonly conditions: Pick<ActionMapConditions, "matchesConditions" | "hasNoConditions">,
    private readonly setData: (name: string, value: unknown) => void,
  ) {}

  public handleRawSequence(sequence: string): boolean {
    if (this.state.core.destroyed) {
      return false
    }

    const hooks = this.state.config.rawHooks.snapshot()
    if (hooks.length === 0) {
      return false
    }

    let stopped = false
    const context: ActionMapRawInputContext = {
      sequence,
      stop() {
        stopped = true
      },
    }

    for (const hook of hooks) {
      try {
        hook.listener(context)
      } catch (error) {
        this.notify.emitError("[ActionMap] Error in raw input hook:", error)
      }

      if (stopped) {
        return true
      }
    }

    return false
  }

  public handleKeyEvent(event: KeyEvent, release: boolean): void {
    if (this.state.core.destroyed) {
      return
    }

    const hooks = this.state.config.keyHooks.snapshot()
    const context: ActionMapKeyInputContext = {
      event,
      setData: (name, value) => {
        this.setData(name, value)
      },
      getData: (name) => {
        return this.state.runtime.data[name]
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
        this.notify.emitError("[ActionMap] Error in key input hook:", error)
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
    const activeLayers = this.layers.getActiveLayers(focused)
    const hasLayerConditions = this.state.layers.layersWithConditions > 0
    const matchKeys = this.resolveEventMatchKeys(event)

    layerLoop: for (const layer of activeLayers) {
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
    const pending = this.projections.ensureValidPendingSequence()
    const matchKeys = this.resolveEventMatchKeys(event)

    if (pending) {
      this.dispatchPendingSequence(pending, matchKeys, event, focused)
      return
    }

    const activeLayers = this.layers.getActiveLayers(focused)
    this.dispatchFromRoot(activeLayers, matchKeys, event, focused)
  }

  private dispatchPendingSequence(
    pending: PendingSequenceState,
    matchKeys: readonly string[],
    event: KeyEvent,
    focused: Renderable | null,
  ): void {
    const nextNode = this.getReachableChild(pending.node, matchKeys)
    if (!nextNode) {
      this.notify.setPendingSequence(null)
      return
    }

    if (nextNode.children.size > 0) {
      this.notify.setPendingSequence({
        layer: pending.layer,
        node: nextNode,
      })
      event.preventDefault()
      event.stopPropagation()
      return
    }

    this.runBindings(pending.layer, nextNode.bindings, event, focused)
    this.notify.setPendingSequence(null)
  }

  private dispatchFromRoot(
    activeLayers: RegisteredLayer[],
    matchKeys: readonly string[],
    event: KeyEvent,
    focused: Renderable | null,
  ): void {
    const hasLayerConditions = this.state.layers.layersWithConditions > 0

    layerLoop: for (const layer of activeLayers) {
      if (hasLayerConditions && !this.conditions.hasNoConditions(layer) && !this.conditions.matchesConditions(layer)) {
        continue
      }

      const nextNode = this.getReachableChild(layer.root, matchKeys)
      if (!nextNode) {
        continue
      }

      if (nextNode.children.size > 0) {
        this.notify.setPendingSequence({
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
    const resolvers = this.state.config.eventMatchResolvers.snapshot()

    if (resolvers.length === 0) {
      return []
    }

    if (resolvers.length === 1) {
      return resolveSingleEventMatchKeys(resolvers[0]!, event, this.notify)
    }

    const keys: string[] = []
    const seen = new Set<string>()

    for (const resolver of resolvers) {
      let resolved: readonly string[] | undefined

      try {
        resolved = resolver(event)
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

      const bindingHandled = this.runBinding(layer, binding, event, focused)
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

  private getReachableChild(node: SequenceNode, matchKeys: readonly string[]): SequenceNode | undefined {
    for (const strokeKey of matchKeys) {
      const child = node.children.get(strokeKey)
      if (!child || !this.projections.nodeHasReachableBindings(child)) {
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

      const bindingHandled = this.runBinding(layer, binding, event, focused)
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

  private runBinding(
    layer: RegisteredLayer,
    binding: CompiledBinding,
    event: KeyEvent,
    focused: Renderable | null,
  ): boolean {
    const run = binding.run
    if (!run) {
      return false
    }

    const context: ActionMapCommandContext = {
      actionMap: this.actionMap,
      event,
      focused,
      target: layer.target ?? null,
      data: this.notify.getReadonlyData(),
    }

    let result: ActionMapCommandResult
    try {
      result = run(context)
    } catch (error) {
      this.notify.emitError(`[ActionMap] Error running command ${describeBindingCommand(binding)}:`, error)
      applyBindingEventEffects(binding, event)
      return true
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        this.notify.emitError(`[ActionMap] Async error in command ${describeBindingCommand(binding)}:`, error)
      })
      applyBindingEventEffects(binding, event)
      return true
    }

    if (result === false) {
      return false
    }

    applyBindingEventEffects(binding, event)
    return true
  }
}

function resolveSingleEventMatchKeys(
  resolver: ActionMapEventMatchResolver,
  event: KeyEvent,
  notify: ActionMapNotifier,
): string[] {
  let resolved: readonly string[] | undefined
  try {
    resolved = resolver(event)
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

function describeBindingCommand(binding: CompiledBinding): string {
  if (typeof binding.command === "string") {
    return `"${binding.command}"`
  }

  if (typeof binding.command === "function") {
    return "<function>"
  }

  return "<none>"
}

function applyBindingEventEffects(binding: CompiledBinding, event: KeyEvent): void {
  if (!binding.preventDefault) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
}
