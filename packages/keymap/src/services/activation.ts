import type { Emitter } from "../lib/emitter.js"
import type {
  ActiveBinding,
  ActiveKey,
  ActiveKeyOptions,
  ActiveKeySelection,
  ActiveKeyState,
  CompiledBinding,
  Hooks,
  KeyMatch,
  KeymapEvent,
  KeymapHost,
  KeySequencePart,
  NormalizedKeyStroke,
  PendingSequenceState,
  RegisteredLayer,
  SequenceNode,
} from "../types.js"
import {
  getActiveLayersForFocused,
  getFocusedTargetIfAvailable,
  isLayerActiveForFocused,
} from "./primitives/active-layers.js"
import type { CommandCatalogService } from "./command-catalog.js"
import { cloneKeyStroke, createKeySequencePart, stringifyKeyStroke } from "./keys.js"
import type { ConditionService } from "./conditions.js"
import type { NotificationService } from "./notify.js"
import type { ActiveCommandView, State } from "./state.js"

function getLiveHost<TTarget extends object, TEvent extends KeymapEvent>(
  host: KeymapHost<TTarget, TEvent>,
): KeymapHost<TTarget, TEvent> {
  if (host.isDestroyed) {
    throw new Error("Cannot use a keymap after its host was destroyed")
  }

  return host
}

function isSamePendingSequence<TTarget extends object, TEvent extends KeymapEvent>(
  current: PendingSequenceState<TTarget, TEvent> | null,
  next: PendingSequenceState<TTarget, TEvent> | null,
): boolean {
  if (current === next) {
    return true
  }

  if (!current || !next) {
    return false
  }

  return current.layer === next.layer && current.node === next.node
}

export class ActivationService<TTarget extends object, TEvent extends KeymapEvent> {
  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly host: KeymapHost<TTarget, TEvent>,
    private readonly hooks: Emitter<Hooks<TTarget, TEvent>>,
    private readonly notify: NotificationService<TTarget, TEvent>,
    private readonly conditions: ConditionService<TTarget, TEvent>,
    private readonly catalog: CommandCatalogService<TTarget, TEvent>,
  ) {}

  public getFocusedTarget(): TTarget | null {
    return getLiveHost(this.host).getFocusedTarget()
  }

  public getFocusedTargetIfAvailable(): TTarget | null {
    return getFocusedTargetIfAvailable(this.host)
  }

  public setPendingSequence(next: PendingSequenceState<TTarget, TEvent> | null): void {
    if (isSamePendingSequence(this.state.projection.pendingSequence, next)) {
      return
    }

    this.state.projection.pendingSequence = next
    this.invalidateCaches()
    this.notifyPendingSequenceChange()
    this.notify.queueStateChange()
  }

  public ensureValidPendingSequence(): PendingSequenceState<TTarget, TEvent> | undefined {
    const pending = this.state.projection.pendingSequence
    if (!pending) {
      return undefined
    }

    const focused = this.getFocusedTarget()
    if (!this.state.layers.layers.has(pending.layer) || !this.isLayerActiveForFocused(pending.layer, focused)) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.conditions.layerMatchesRuntimeState(pending.layer)) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.nodeHasReachableBindings(pending.node, focused)) {
      this.setPendingSequence(null)
      return undefined
    }

    return this.state.projection.pendingSequence ?? undefined
  }

  public getPendingSequence(): readonly KeySequencePart[] {
    const projections = this.state.projection
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (projections.pendingSequenceCacheVersion === derivedStateVersion) {
      return projections.pendingSequenceCache
    }

    const pending = this.ensureValidPendingSequence()
    const canUseCache = !pending || this.layerCanCacheActiveKeys(pending.layer)
    const sequence = pending ? this.collectSequencePartsFromNode(pending.node) : []

    if (canUseCache) {
      projections.pendingSequenceCacheVersion = derivedStateVersion
      projections.pendingSequenceCache = sequence
    }

    return sequence
  }

  public popPendingSequence(): boolean {
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

  public getActiveKeys(options?: ActiveKeyOptions): readonly ActiveKey<TTarget, TEvent>[] {
    const projections = this.state.projection
    const derivedStateVersion = this.state.notify.derivedStateVersion
    const includeBindings = options?.includeBindings === true
    const includeMetadata = options?.includeMetadata === true

    if (includeBindings) {
      if (includeMetadata) {
        if (projections.activeKeysBindingsAndMetadataCacheVersion === derivedStateVersion) {
          return projections.activeKeysBindingsAndMetadataCache
        }
      } else if (projections.activeKeysBindingsCacheVersion === derivedStateVersion) {
        return projections.activeKeysBindingsCache
      }
    } else if (includeMetadata) {
      if (projections.activeKeysMetadataCacheVersion === derivedStateVersion) {
        return projections.activeKeysMetadataCache
      }
    } else if (projections.activeKeysPlainCacheVersion === derivedStateVersion) {
      return projections.activeKeysPlainCache
    }

    const focused = this.getFocusedTarget()
    const activeView = this.catalog.getActiveCommandView(focused)
    const pending = this.ensureValidPendingSequence()
    const activeLayers = pending ? [] : this.getActiveLayers(focused)
    const canUseCache = pending
      ? this.layerCanCacheActiveKeys(pending.layer)
      : this.activeLayersCanCacheActiveKeys(activeLayers)

    const activeKeys = pending
      ? this.collectActiveKeysFromChildren(pending.node.children, includeBindings, includeMetadata, focused, activeView)
      : this.collectActiveKeysAtRoot(activeLayers, includeBindings, includeMetadata, focused, activeView)

    if (!canUseCache) {
      return activeKeys
    }

    if (includeBindings) {
      if (includeMetadata) {
        projections.activeKeysBindingsAndMetadataCacheVersion = derivedStateVersion
        projections.activeKeysBindingsAndMetadataCache = activeKeys
      } else {
        projections.activeKeysBindingsCacheVersion = derivedStateVersion
        projections.activeKeysBindingsCache = activeKeys
      }
    } else if (includeMetadata) {
      projections.activeKeysMetadataCacheVersion = derivedStateVersion
      projections.activeKeysMetadataCache = activeKeys
    } else {
      projections.activeKeysPlainCacheVersion = derivedStateVersion
      projections.activeKeysPlainCache = activeKeys
    }

    return activeKeys
  }

  public nodeHasReachableBindings(node: SequenceNode<TTarget, TEvent>, focused: TTarget | null): boolean {
    return this.hasMatchingBindings(node.reachableBindings, focused, this.catalog.getActiveCommandView(focused))
  }

  public getActiveLayers(focused: TTarget | null): RegisteredLayer<TTarget, TEvent>[] {
    return getActiveLayersForFocused(this.state.layers.targetLayers, this.host, focused)
  }

  public isLayerActiveForFocused(layer: RegisteredLayer<TTarget, TEvent>, focused: TTarget | null): boolean {
    return isLayerActiveForFocused(this.host, layer, focused)
  }

  public layerCanCacheActiveKeys(layer: RegisteredLayer<TTarget, TEvent>): boolean {
    return !layer.hasUnkeyedMatchers && !layer.hasUnkeyedBindings
  }

  public activeLayersCanCacheActiveKeys(activeLayers: readonly RegisteredLayer<TTarget, TEvent>[]): boolean {
    for (const layer of activeLayers) {
      if (!this.layerCanCacheActiveKeys(layer)) {
        return false
      }
    }

    return true
  }

  private collectSequencePartsFromNode(node: SequenceNode<TTarget, TEvent>): KeySequencePart[] {
    const nodes: SequenceNode<TTarget, TEvent>[] = []
    let current: SequenceNode<TTarget, TEvent> | null = node

    while (current && current.stroke) {
      nodes.push(current)
      current = current.parent
    }

    nodes.reverse()

    const focused = this.getFocusedTarget()
    const activeView = this.catalog.getActiveCommandView(focused)

    return nodes.map((candidate) => {
      const presentation = this.getNodePresentation(candidate, focused, activeView)

      return createKeySequencePart(candidate.stroke!, {
        display: presentation.display,
        match: candidate.match!,
        tokenName: presentation.tokenName,
      })
    })
  }

  private getMatchingBindings(
    bindings: readonly CompiledBinding<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): CompiledBinding<TTarget, TEvent>[] {
    const matches: CompiledBinding<TTarget, TEvent>[] = []

    for (const binding of bindings) {
      if (this.conditions.matchesConditions(binding) && this.catalog.isBindingVisible(binding, focused, activeView)) {
        matches.push(binding)
      }
    }

    return matches
  }

  private hasMatchingBindings(
    bindings: readonly CompiledBinding<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): boolean {
    for (const binding of bindings) {
      if (this.conditions.matchesConditions(binding) && this.catalog.isBindingVisible(binding, focused, activeView)) {
        return true
      }
    }

    return false
  }

  private getNodePresentation(
    node: SequenceNode<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
    reachableBindings: readonly CompiledBinding<TTarget, TEvent>[] = this.getMatchingBindings(
      node.reachableBindings,
      focused,
      activeView,
    ),
  ): { display: string; tokenName?: string } {
    if (!node.stroke) {
      return { display: "" }
    }

    const partIndex = node.depth - 1
    let display: string | undefined
    let tokenName: string | undefined
    let hasDisplayConflict = false
    let hasTokenConflict = false

    for (const binding of reachableBindings) {
      const part = binding.sequence[partIndex]
      if (!part) {
        continue
      }

      if (display === undefined) {
        display = part.display
        tokenName = part.tokenName
        continue
      }

      if (!hasDisplayConflict && display !== part.display) {
        hasDisplayConflict = true
      }

      if (!hasTokenConflict && tokenName !== part.tokenName) {
        hasTokenConflict = true
      }
    }

    if (display === undefined || hasDisplayConflict) {
      display = stringifyKeyStroke(node.stroke)
    }

    if (hasTokenConflict) {
      tokenName = undefined
    }

    return {
      display,
      tokenName,
    }
  }

  private toActiveBinding(
    binding: CompiledBinding<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveBinding<TTarget, TEvent> {
    return {
      sequence: binding.sequence,
      command: binding.command,
      commandAttrs: this.catalog.getBindingCommandAttrs(binding, focused, activeView),
      attrs: binding.attrs,
      event: binding.event,
      preventDefault: binding.preventDefault,
      fallthrough: binding.fallthrough,
    }
  }

  private collectActiveBindings(
    bindings: readonly CompiledBinding<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveBinding<TTarget, TEvent>[] {
    return bindings.map((binding) => this.toActiveBinding(binding, focused, activeView))
  }

  private collectActiveKeysAtRoot(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): readonly ActiveKey<TTarget, TEvent>[] {
    const activeKeys = new Map<KeyMatch, ActiveKeyState<TTarget, TEvent>>()
    const stopped = new Set<KeyMatch>()
    const hasLayerConditions = this.state.layers.layersWithConditions > 0

    for (const layer of activeLayers) {
      if (layer.root.children.size === 0) {
        continue
      }

      if (hasLayerConditions && !this.conditions.hasNoConditions(layer) && !this.conditions.matchesConditions(layer)) {
        continue
      }

      for (const [bindingKey, child] of layer.root.children) {
        if (stopped.has(bindingKey)) {
          continue
        }

        const selection = this.selectActiveKey(child, includeBindings, focused, activeView)
        if (!selection) {
          continue
        }

        const existing = activeKeys.get(bindingKey)
        if (!existing) {
          activeKeys.set(bindingKey, this.createActiveKeyState(child.stroke!, selection, includeBindings))
        } else {
          this.updateActiveKeyState(existing, selection, includeBindings)
        }

        if (selection.stop) {
          stopped.add(bindingKey)
        }
      }
    }

    const materialized: ActiveKey<TTarget, TEvent>[] = []
    for (const state of activeKeys.values()) {
      const activeKey = this.materializeActiveKey(state, includeBindings, includeMetadata, focused, activeView)
      if (activeKey) {
        materialized.push(activeKey)
      }
    }

    return materialized
  }

  private collectActiveKeysFromChildren(
    children: ReadonlyMap<KeyMatch, SequenceNode<TTarget, TEvent>>,
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): readonly ActiveKey<TTarget, TEvent>[] {
    const activeKeys: ActiveKey<TTarget, TEvent>[] = []

    for (const child of children.values()) {
      const selection = this.selectActiveKey(child, includeBindings, focused, activeView)
      if (!selection) {
        continue
      }

      const activeKey = this.materializeActiveKey(
        this.createActiveKeyState(child.stroke!, selection, includeBindings),
        includeBindings,
        includeMetadata,
        focused,
        activeView,
      )
      if (activeKey) {
        activeKeys.push(activeKey)
      }
    }

    return activeKeys
  }

  private selectActiveKey(
    node: SequenceNode<TTarget, TEvent>,
    includeBindings: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveKeySelection<TTarget, TEvent> | undefined {
    return node.children.size > 0
      ? this.selectPrefixActiveKey(node, includeBindings, focused, activeView)
      : this.selectExactActiveKey(node, includeBindings, focused, activeView)
  }

  private selectPrefixActiveKey(
    node: SequenceNode<TTarget, TEvent>,
    includeBindings: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveKeySelection<TTarget, TEvent> | undefined {
    if (!node.stroke) {
      return undefined
    }

    const reachableBindings = this.getMatchingBindings(node.reachableBindings, focused, activeView)
    if (reachableBindings.length === 0) {
      return undefined
    }

    const prefixBindings = this.getMatchingBindings(node.bindings, focused, activeView)

    return {
      ...this.getNodePresentation(node, focused, activeView, reachableBindings),
      continues: true,
      firstBinding: prefixBindings[0],
      bindings: includeBindings && prefixBindings.length > 0 ? prefixBindings : undefined,
      stop: true,
    }
  }

  private selectExactActiveKey(
    node: SequenceNode<TTarget, TEvent>,
    includeBindings: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveKeySelection<TTarget, TEvent> | undefined {
    if (!node.stroke) {
      return undefined
    }

    const selected = this.selectActiveBindings(node.bindings, focused, activeView)
    if (!selected) {
      return undefined
    }

    let display: string
    let tokenName: string | undefined

    if (selected.bindings.length === 1) {
      const part = selected.bindings[0]?.sequence[node.depth - 1]
      display = part?.display ?? stringifyKeyStroke(node.stroke)
      tokenName = part?.tokenName
    } else {
      const presentation = this.getNodePresentation(node, focused, activeView, selected.bindings)
      display = presentation.display
      tokenName = presentation.tokenName
    }

    return {
      display,
      tokenName,
      continues: false,
      firstBinding: selected.bindings[0],
      commandBinding: selected.commandBinding,
      bindings: includeBindings ? [...selected.bindings] : undefined,
      stop: selected.stop,
    }
  }

  private selectActiveBindings(
    bindings: readonly CompiledBinding<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ):
    | {
        bindings: readonly CompiledBinding<TTarget, TEvent>[]
        commandBinding?: CompiledBinding<TTarget, TEvent>
        stop: boolean
      }
    | undefined {
    const selected: CompiledBinding<TTarget, TEvent>[] = []
    let commandBinding: CompiledBinding<TTarget, TEvent> | undefined

    for (const binding of bindings) {
      if (!this.conditions.matchesConditions(binding) || !this.catalog.isBindingVisible(binding, focused, activeView)) {
        continue
      }

      selected.push(binding)
      if (binding.command === undefined) {
        continue
      }

      commandBinding ??= binding
      if (!binding.fallthrough) {
        return { bindings: selected, commandBinding, stop: true }
      }
    }

    if (selected.length === 0) {
      return undefined
    }

    return { bindings: selected, commandBinding, stop: false }
  }

  private createActiveKeyState(
    stroke: NormalizedKeyStroke,
    selection: ActiveKeySelection<TTarget, TEvent>,
    includeBindings: boolean,
  ): ActiveKeyState<TTarget, TEvent> {
    return {
      stroke,
      display: selection.display,
      tokenName: selection.tokenName,
      continues: selection.continues,
      firstBinding: selection.firstBinding,
      commandBinding: selection.commandBinding,
      bindings: includeBindings && selection.bindings ? [...selection.bindings] : undefined,
    }
  }

  private updateActiveKeyState(
    state: ActiveKeyState<TTarget, TEvent>,
    selection: ActiveKeySelection<TTarget, TEvent>,
    includeBindings: boolean,
  ): void {
    if (!state.firstBinding && selection.firstBinding) {
      state.firstBinding = selection.firstBinding
    }

    if (!state.commandBinding && selection.commandBinding) {
      state.commandBinding = selection.commandBinding
    }

    if (selection.continues) {
      state.continues = true
    }

    if (!includeBindings || !selection.bindings || selection.bindings.length === 0) {
      return
    }

    if (!state.bindings) {
      state.bindings = [...selection.bindings]
      return
    }

    state.bindings.push(...selection.bindings)
  }

  private materializeActiveKey(
    state: ActiveKeyState<TTarget, TEvent>,
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveKey<TTarget, TEvent> | undefined {
    if (!state.commandBinding && !state.continues) {
      return undefined
    }

    const activeKey: ActiveKey<TTarget, TEvent> = {
      stroke: cloneKeyStroke(state.stroke),
      display: state.display,
      continues: state.continues,
    }

    if (state.tokenName) {
      activeKey.tokenName = state.tokenName
    }

    if (state.commandBinding) {
      activeKey.command = state.commandBinding.command
    }

    if (includeBindings && state.bindings && state.bindings.length > 0) {
      activeKey.bindings =
        state.bindings.length === 1
          ? [this.toActiveBinding(state.bindings[0]!, focused, activeView)]
          : this.collectActiveBindings(state.bindings, focused, activeView)
    }

    if (includeMetadata) {
      if (state.firstBinding?.attrs) {
        activeKey.bindingAttrs = state.firstBinding.attrs
      }

      const commandAttrs = state.commandBinding
        ? this.catalog.getBindingCommandAttrs(state.commandBinding, focused, activeView)
        : undefined
      if (commandAttrs) {
        activeKey.commandAttrs = commandAttrs
      }
    }

    return activeKey
  }

  private invalidateCaches(): void {
    this.state.projection.pendingSequenceCacheVersion = -1
    this.state.projection.activeKeysPlainCacheVersion = -1
    this.state.projection.activeKeysBindingsCacheVersion = -1
    this.state.projection.activeKeysMetadataCacheVersion = -1
    this.state.projection.activeKeysBindingsAndMetadataCacheVersion = -1
  }

  private notifyPendingSequenceChange(): void {
    if (!this.hooks.has("pendingSequence")) {
      return
    }

    this.hooks.emit(
      "pendingSequence",
      this.state.projection.pendingSequence
        ? this.collectSequencePartsFromNode(this.state.projection.pendingSequence.node)
        : [],
    )
  }
}
