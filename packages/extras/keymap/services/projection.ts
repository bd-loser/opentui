import type { Emitter } from "../lib/emitter.js"
import {
  createParsedKeyPart,
  getRegisteredCommandRecord,
  resolveRegisteredCommand,
  snapshotStroke,
  stringifyKeyStroke,
} from "../lib/utils.js"
import type {
  ActiveBinding,
  ActiveKey,
  ActiveKeyOptions,
  ActiveKeySelection,
  ActiveKeyState,
  Attributes,
  CommandQuery,
  CommandQueryValue,
  CommandRecord,
  CommandResolverContext,
  CompiledBinding,
  Hooks,
  KeymapEvent,
  KeymapHost,
  KeySequencePart,
  NormalizedKeyStroke,
  PendingSequenceState,
  RegisteredCommand,
  RegisteredLayer,
  ResolvedBindingCommand,
  SequenceNode,
} from "../types.js"
import type { ConditionService } from "./conditions.js"
import type { NotificationService } from "./notify.js"
import type { ActiveCommandView, LayerCommandEntry, ResolvedCommandEntry, State } from "./state.js"

const DEFAULT_COMMAND_SEARCH_FIELDS = ["name"] as const

interface ResolvedCommandLookup<TTarget extends object, TEvent extends KeymapEvent> {
  resolved?: ResolvedBindingCommand<TTarget, TEvent>
  hadError: boolean
}

interface QueryRegisteredCommandsOptions<TTarget extends object, TEvent extends KeymapEvent> {
  commands: Iterable<RegisteredCommand<TTarget, TEvent>>
  query?: CommandQuery<TTarget>
  getCommandRecord(command: RegisteredCommand<TTarget, TEvent>): CommandRecord
  onFilterError(error: unknown): void
}

function getLiveHost<TTarget extends object, TEvent extends KeymapEvent>(host: KeymapHost<TTarget, TEvent>): KeymapHost<TTarget, TEvent> {
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

export class ProjectionService<TTarget extends object, TEvent extends KeymapEvent> {
  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly host: KeymapHost<TTarget, TEvent>,
    private readonly hooks: Emitter<Hooks<TTarget, TEvent>>,
    private readonly notify: NotificationService<TTarget, TEvent>,
    private readonly conditions: ConditionService<TTarget, TEvent>,
  ) {}

  public getFocusedTarget(): TTarget | null {
    return getLiveHost(this.host).getFocusedTarget()
  }

  public getFocusedTargetIfAvailable(): TTarget | null {
    if (this.host.isDestroyed) {
      return null
    }

    return this.getFocusedTarget()
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
    const activeView = this.getActiveCommandView(focused)
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

  public getCommands(query?: CommandQuery<TTarget>): readonly CommandRecord[] {
    const visibility = query?.visibility ?? "reachable"
    const focused =
      query && Object.prototype.hasOwnProperty.call(query, "focused")
        ? (query.focused ?? null)
        : this.getFocusedTargetIfAvailable()

    let commands: readonly RegisteredCommand<TTarget, TEvent>[]
    if (visibility === "registered") {
      commands = this.getRegisteredCommands()
    } else {
      const view = this.getActiveCommandView(focused)
      commands =
        visibility === "active"
          ? view.entries.map((entry) => entry.command)
          : view.reachable.map((entry) => entry.command)
    }

    return queryRegisteredCommands({
      commands,
      query,
      getCommandRecord: (command) => getRegisteredCommandRecord(command),
      onFilterError: (error) => {
        this.notify.emitError("command-query-filter-error", error, "[Keymap] Error in command query filter:")
      },
    })
  }

  public getResolvedCommandChain(
    command: string,
    focused: TTarget | null,
    includeRecord: boolean,
  ): { entries?: readonly ResolvedCommandEntry<TTarget, TEvent>[]; hadError: boolean } {
    const view = this.getActiveCommandView(focused)
    const entries = this.getResolvedCommandChainFromView(view, command, focused, includeRecord)
    const hadError = (includeRecord ? view.fallbackWithRecordErrors : view.fallbackWithoutRecordErrors).has(command)

    return { entries, hadError }
  }

  public getCommandAttrs(command: string, focused: TTarget | null): Readonly<Attributes> | undefined {
    const top = this.getTopResolvedCommand(command, focused, false)
    return top?.resolved.attrs
  }

  public getTopCommandRecord(command: string, focused: TTarget | null): CommandRecord | undefined {
    const top = this.getTopResolvedCommand(command, focused, true)
    return top?.resolved.record
  }

  public nodeHasReachableBindings(node: SequenceNode<TTarget, TEvent>, focused: TTarget | null): boolean {
    return this.hasMatchingBindings(node.reachableBindings, focused, this.getActiveCommandView(focused))
  }

  public getActiveLayers(focused: TTarget | null): RegisteredLayer<TTarget, TEvent>[] {
    const activeLayers: RegisteredLayer<TTarget, TEvent>[] = []

    this.forEachActivationTarget(focused, (current, isFocusedTarget) => {
      const bucket = this.state.layers.targetLayers.get(current)
      if (bucket) {
        if (isFocusedTarget) {
          activeLayers.push(...bucket.focusLayers)
        }

        activeLayers.push(...bucket.focusWithinLayers)
      }
    })

    return activeLayers
  }

  public isLayerActiveForFocused(layer: RegisteredLayer<TTarget, TEvent>, focused: TTarget | null): boolean {
    const target = layer.indexTarget
    if (this.host.isTargetDestroyed(target)) {
      return false
    }

    if (layer.scope === "focus") {
      return target === focused
    }

    let isActive = false
    this.forEachActivationTarget(focused, (current) => {
      if (current === target) {
        isActive = true
        return false
      }

      return true
    })

    return isActive
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

  private forEachActivationTarget(
    focused: TTarget | null,
    visit: (target: TTarget, isFocusedTarget: boolean) => boolean | void,
  ): void {
    let current: TTarget | null = focused ?? this.host.rootTarget
    let isFocusedTarget = focused !== null

    while (current) {
      const shouldContinue = visit(current, isFocusedTarget)
      if (shouldContinue === false) {
        return
      }

      current = this.host.getParentTarget(current)
      isFocusedTarget = false
    }
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
    const activeView = this.getActiveCommandView(focused)

    return nodes.map((candidate) => {
      return createParsedKeyPart(
        candidate.stroke!,
        this.getNodeDisplay(candidate, focused, activeView),
        candidate.matchKey!,
      )
    })
  }

  private getMatchingBindings(
    bindings: readonly CompiledBinding<TTarget, TEvent>[],
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): CompiledBinding<TTarget, TEvent>[] {
    const matches: CompiledBinding<TTarget, TEvent>[] = []

    for (const binding of bindings) {
      if (this.conditions.matchesConditions(binding) && this.isVisibleBinding(binding, focused, activeView)) {
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
      if (this.conditions.matchesConditions(binding) && this.isVisibleBinding(binding, focused, activeView)) {
        return true
      }
    }

    return false
  }

  private isVisibleBinding(
    binding: CompiledBinding<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): boolean {
    if (binding.command === undefined || binding.run) {
      return true
    }

    if (typeof binding.command !== "string") {
      return false
    }

    if (activeView.reachableByName.has(binding.command)) {
      return true
    }

    return this.getFallbackResolvedCommand(activeView, binding.command, focused, false) !== undefined
  }

  private getNodeDisplay(
    node: SequenceNode<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
    reachableBindings: readonly CompiledBinding<TTarget, TEvent>[] = this.getMatchingBindings(
      node.reachableBindings,
      focused,
      activeView,
    ),
  ): string {
    if (!node.stroke) {
      return ""
    }

    const partIndex = node.depth - 1
    let display: string | undefined

    for (const binding of reachableBindings) {
      const part = binding.sequence[partIndex]
      if (!part) {
        continue
      }

      if (display === undefined) {
        display = part.display
        continue
      }

      if (display !== part.display) {
        return stringifyKeyStroke(node.stroke)
      }
    }

    return display ?? stringifyKeyStroke(node.stroke)
  }

  private toActiveBinding(
    binding: CompiledBinding<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): ActiveBinding<TTarget, TEvent> {
    return {
      sequence: binding.sequence,
      command: binding.command,
      commandAttrs: this.getActiveCommandAttrs(binding, focused, activeView),
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

  private getActiveCommandAttrs(
    binding: CompiledBinding<TTarget, TEvent>,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): Readonly<Attributes> | undefined {
    if (typeof binding.command !== "string") {
      return undefined
    }

    const active = activeView.reachableByName.get(binding.command)
    if (active) {
      return active.command.attrs
    }

    const fallback = this.getFallbackResolvedCommand(activeView, binding.command, focused, false)
    return fallback?.resolved.attrs
  }

  private collectActiveKeysAtRoot(
    activeLayers: RegisteredLayer<TTarget, TEvent>[],
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: TTarget | null,
    activeView: ActiveCommandView<TTarget, TEvent>,
  ): readonly ActiveKey<TTarget, TEvent>[] {
    const activeKeys = new Map<string, ActiveKeyState<TTarget, TEvent>>()
    const stopped = new Set<string>()
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
    children: ReadonlyMap<string, SequenceNode<TTarget, TEvent>>,
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
      display: this.getNodeDisplay(node, focused, activeView, reachableBindings),
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

    const display =
      selected.bindings.length === 1
        ? (selected.bindings[0]?.sequence[node.depth - 1]?.display ?? stringifyKeyStroke(node.stroke))
        : this.getNodeDisplay(node, focused, activeView, selected.bindings)

    return {
      display,
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
    | { bindings: readonly CompiledBinding<TTarget, TEvent>[]; commandBinding?: CompiledBinding<TTarget, TEvent>; stop: boolean }
    | undefined {
    const selected: CompiledBinding<TTarget, TEvent>[] = []
    let commandBinding: CompiledBinding<TTarget, TEvent> | undefined

    for (const binding of bindings) {
      if (!this.conditions.matchesConditions(binding) || !this.isVisibleBinding(binding, focused, activeView)) {
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
      stroke: snapshotStroke(state.stroke),
      display: state.display,
      continues: state.continues,
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
        ? this.getActiveCommandAttrs(state.commandBinding, focused, activeView)
        : undefined
      if (commandAttrs) {
        activeKey.commandAttrs = commandAttrs
      }
    }

    return activeKey
  }

  private getTopResolvedCommand(
    command: string,
    focused: TTarget | null,
    includeRecord: boolean,
  ): ResolvedCommandEntry<TTarget, TEvent> | undefined {
    const activeView = this.getActiveCommandView(focused)
    const active = activeView.reachableByName.get(command)
    if (active) {
      return {
        target: active.layer.target,
        resolved: resolveRegisteredCommand(active.command, { includeRecord }),
      }
    }

    return this.getFallbackResolvedCommand(activeView, command, focused, includeRecord)
  }

  private getFallbackResolvedCommand(
    activeView: ActiveCommandView<TTarget, TEvent>,
    command: string,
    focused: TTarget | null,
    includeRecord: boolean,
  ): ResolvedCommandEntry<TTarget, TEvent> | undefined {
    const cache = includeRecord ? activeView.fallbackWithRecord : activeView.fallbackWithoutRecord
    const errorCache = includeRecord ? activeView.fallbackWithRecordErrors : activeView.fallbackWithoutRecordErrors
    if (cache.has(command)) {
      const cached = cache.get(command)
      return cached ? { resolved: cached } : undefined
    }

    const lookup = this.resolveCommandWithResolvers(command, focused, { includeRecord })
    cache.set(command, lookup.resolved ?? null)
    if (lookup.hadError) {
      errorCache.add(command)
    }

    if (!lookup.resolved) {
      return undefined
    }

    return { resolved: lookup.resolved }
  }

  private getResolvedCommandChainFromView(
    activeView: ActiveCommandView<TTarget, TEvent>,
    command: string,
    focused: TTarget | null,
    includeRecord: boolean,
  ): readonly ResolvedCommandEntry<TTarget, TEvent>[] | undefined {
    const cache = includeRecord ? activeView.resolvedWithRecordChains : activeView.resolvedWithoutRecordChains
    const cached = cache.get(command)
    if (cached) {
      return cached.length > 0 ? cached : undefined
    }

    const resolved: ResolvedCommandEntry<TTarget, TEvent>[] = []
    const activeChain = activeView.chainsByName.get(command)
    if (activeChain) {
      for (const entry of activeChain) {
        resolved.push({
          target: entry.layer.target,
          resolved: resolveRegisteredCommand(entry.command, { includeRecord }),
        })
      }
    }

    const fallback = this.getFallbackResolvedCommand(activeView, command, focused, includeRecord)
    if (fallback) {
      resolved.push(fallback)
    }

    cache.set(command, resolved)
    return resolved.length > 0 ? resolved : undefined
  }

  private getActiveCommandView(focused: TTarget | null): ActiveCommandView<TTarget, TEvent> {
    const currentFocused = this.getFocusedTargetIfAvailable()
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (
      focused === currentFocused &&
      this.state.projection.activeCommandViewVersion === derivedStateVersion &&
      this.state.projection.activeCommandView
    ) {
      return this.state.projection.activeCommandView
    }

    const entries: LayerCommandEntry<TTarget, TEvent>[] = []
    const reachable: LayerCommandEntry<TTarget, TEvent>[] = []
    const reachableByName = new Map<string, LayerCommandEntry<TTarget, TEvent>>()
    const chainsByName = new Map<string, LayerCommandEntry<TTarget, TEvent>[]>()

    if (this.state.layers.layersWithCommands > 0) {
      for (const layer of this.getActiveLayers(focused)) {
        if (layer.commands.length === 0 || !this.conditions.layerMatchesRuntimeState(layer)) {
          continue
        }

        for (const command of layer.commands) {
          const entry: LayerCommandEntry<TTarget, TEvent> = { layer, command }
          entries.push(entry)

          const existing = chainsByName.get(command.name)
          if (existing) {
            existing.push(entry)
          } else {
            chainsByName.set(command.name, [entry])
          }

          if (!reachableByName.has(command.name)) {
            reachableByName.set(command.name, entry)
            reachable.push(entry)
          }
        }
      }
    }

    const view: ActiveCommandView<TTarget, TEvent> = {
      entries,
      reachable,
      reachableByName,
      chainsByName,
      resolvedWithoutRecordChains: new Map(),
      resolvedWithRecordChains: new Map(),
      fallbackWithoutRecord: new Map(),
      fallbackWithRecord: new Map(),
      fallbackWithoutRecordErrors: new Set(),
      fallbackWithRecordErrors: new Set(),
    }

    if (focused === currentFocused) {
      this.state.projection.activeCommandViewVersion = derivedStateVersion
      this.state.projection.activeCommandView = view
    }

    return view
  }

  private getRegisteredCommands(): readonly RegisteredCommand<TTarget, TEvent>[] {
    const cacheVersion = this.state.commands.commandMetadataVersion
    if (this.state.projection.registeredCommandsCacheVersion === cacheVersion) {
      return this.state.projection.registeredCommandsCache
    }

    const layers = [...this.state.layers.layers]
    layers.sort((left, right) => left.order - right.order)

    const commands: RegisteredCommand<TTarget, TEvent>[] = []
    for (const layer of layers) {
      if (layer.commands.length > 0) {
        commands.push(...layer.commands)
      }
    }

    this.state.projection.registeredCommandsCacheVersion = cacheVersion
    this.state.projection.registeredCommandsCache = commands
    return commands
  }

  private resolveCommandWithResolvers(
    command: string,
    focused: TTarget | null,
    options?: { includeRecord?: boolean },
  ): ResolvedCommandLookup<TTarget, TEvent> {
    const resolvers = this.state.config.commandResolvers.values()
    if (resolvers.length === 0) {
      return { hadError: false }
    }

    const includeRecord = options?.includeRecord === true
    const context: CommandResolverContext = {
      getCommandAttrs: (name) => this.getCommandAttrs(name, focused),
      getCommandRecord: (name) => {
        if (!includeRecord) {
          return undefined
        }

        return this.getTopCommandRecord(name, focused)
      },
    }
    let hadError = false

    for (const resolver of resolvers) {
      let resolved: ResolvedBindingCommand<TTarget, TEvent> | undefined

      try {
        resolved = resolver(command, context)
      } catch (error) {
        hadError = true
        this.notify.emitError("command-resolver-error", error, `[Keymap] Error in command resolver for "${command}":`)
        continue
      }

      if (resolved) {
        return { hadError, resolved }
      }
    }

    return { hadError }
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

function queryRegisteredCommands<TTarget extends object, TEvent extends KeymapEvent>(
  options: QueryRegisteredCommandsOptions<TTarget, TEvent>,
): readonly CommandRecord[] {
  const namespace = options.query?.namespace
  const normalizedSearch = options.query?.search?.trim().toLowerCase() ?? ""
  let searchKeys = DEFAULT_COMMAND_SEARCH_FIELDS as readonly string[]
  if (options.query?.searchIn && options.query.searchIn.length > 0) {
    searchKeys = options.query.searchIn
  }

  const filter = options.query?.filter
  let filterEntries: readonly [string, CommandQueryValue][] | undefined
  let filterPredicate: ((command: CommandRecord) => boolean) | undefined

  if (typeof filter === "function") {
    filterPredicate = filter
  } else if (filter) {
    filterEntries = Object.entries(filter)
  }

  const results: CommandRecord[] = []

  for (const command of options.commands) {
    if (!commandMatchesNamespace(command, namespace)) {
      continue
    }

    if (!commandMatchesSearch(command, normalizedSearch, searchKeys)) {
      continue
    }

    if (!commandMatchesFilters(command, filterEntries, options)) {
      continue
    }

    const record = options.getCommandRecord(command)

    if (filterPredicate) {
      let matches = false

      try {
        matches = filterPredicate(record)
      } catch (error) {
        options.onFilterError(error)
        continue
      }

      if (!matches) {
        continue
      }
    }

    results.push(record)
  }

  return results
}

function commandMatchesSearch<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
  search: string,
  searchKeys: readonly string[],
): boolean {
  if (!search) {
    return true
  }

  for (const key of searchKeys) {
    if (commandKeyMatchesSearch(command, key, search)) {
      return true
    }
  }

  return false
}

function commandMatchesNamespace<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
  namespace: string | readonly string[] | undefined,
): boolean {
  if (namespace === undefined) {
    return true
  }

  if (!Object.prototype.hasOwnProperty.call(command.fields, "namespace")) {
    return false
  }

  return commandValueMatchesFilter(command.fields.namespace, namespace)
}

function commandMatchesFilters<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
  filters: readonly [string, CommandQueryValue][] | undefined,
  options: QueryRegisteredCommandsOptions<TTarget, TEvent>,
): boolean {
  if (!filters) {
    return true
  }

  for (const [key, matcher] of filters) {
    if (!commandKeyMatchesQuery(command, key, matcher, options)) {
      return false
    }
  }

  return true
}

function commandKeyMatchesSearch<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
  key: string,
  search: string,
): boolean {
  if (key === "name" && commandValueMatchesSearch(command.name, search)) {
    return true
  }

  if (
    Object.prototype.hasOwnProperty.call(command.fields, key) &&
    commandValueMatchesSearch(command.fields[key], search)
  ) {
    return true
  }

  if (command.attrs && Object.prototype.hasOwnProperty.call(command.attrs, key)) {
    return commandValueMatchesSearch(command.attrs[key], search)
  }

  return false
}

function commandKeyMatchesQuery<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
  key: string,
  matcher: CommandQueryValue,
  options: QueryRegisteredCommandsOptions<TTarget, TEvent>,
): boolean {
  if (typeof matcher === "function") {
    let record: CommandRecord | undefined
    const getRecord = () => {
      if (!record) {
        record = options.getCommandRecord(command)
      }

      return record
    }
    let foundValue = false

    if (key === "name") {
      foundValue = true
      try {
        if (matcher(command.name, getRecord())) {
          return true
        }
      } catch (error) {
        options.onFilterError(error)
        return false
      }
    }

    if (Object.prototype.hasOwnProperty.call(command.fields, key)) {
      foundValue = true

      try {
        if (matcher(command.fields[key], getRecord())) {
          return true
        }
      } catch (error) {
        options.onFilterError(error)
        return false
      }
    }

    if (command.attrs && Object.prototype.hasOwnProperty.call(command.attrs, key)) {
      foundValue = true

      try {
        if (matcher(command.attrs[key], getRecord())) {
          return true
        }
      } catch (error) {
        options.onFilterError(error)
        return false
      }
    }

    if (!foundValue) {
      try {
        return matcher(undefined, getRecord())
      } catch (error) {
        options.onFilterError(error)
        return false
      }
    }

    return false
  }

  return commandKeyMatchesExact(command, key, matcher)
}

function commandKeyMatchesExact<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
  key: string,
  matcher: unknown | readonly unknown[],
): boolean {
  if (key === "name" && commandValueMatchesFilter(command.name, matcher)) {
    return true
  }

  if (
    Object.prototype.hasOwnProperty.call(command.fields, key) &&
    commandValueMatchesFilter(command.fields[key], matcher)
  ) {
    return true
  }

  if (command.attrs && Object.prototype.hasOwnProperty.call(command.attrs, key)) {
    return commandValueMatchesFilter(command.attrs[key], matcher)
  }

  return false
}

function commandValueMatchesFilter(value: unknown, matcher: unknown | readonly unknown[]): boolean {
  if (Array.isArray(matcher)) {
    for (const expected of matcher) {
      if (commandValueMatchesExact(value, expected)) {
        return true
      }
    }

    return false
  }

  return commandValueMatchesExact(value, matcher)
}

function commandValueMatchesExact(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (commandValueMatchesExact(entry, expected)) {
        return true
      }
    }

    return false
  }

  return Object.is(value, expected)
}

function commandValueMatchesSearch(value: unknown, search: string): boolean {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (commandValueMatchesSearch(entry, search)) {
        return true
      }
    }

    return false
  }

  if (typeof value === "string") {
    return value.toLowerCase().includes(search)
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).toLowerCase().includes(search)
  }

  return false
}
