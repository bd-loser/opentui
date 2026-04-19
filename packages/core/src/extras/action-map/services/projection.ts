import type { Renderable } from "../../../Renderable.js"
import type { CliRenderer } from "../../../renderer.js"
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

interface ResolvedCommandLookup {
  resolved?: ResolvedBindingCommand
  hadError: boolean
}

interface QueryRegisteredCommandsOptions {
  commands: Iterable<RegisteredCommand>
  query?: CommandQuery
  getCommandRecord(command: RegisteredCommand): CommandRecord
  onFilterError(error: unknown): void
}

function getLiveRenderer(renderer: CliRenderer): CliRenderer {
  if (renderer.isDestroyed) {
    throw new Error("Cannot use an action map after its renderer was destroyed")
  }

  return renderer
}

function isSamePendingSequence(current: PendingSequenceState | null, next: PendingSequenceState | null): boolean {
  if (current === next) {
    return true
  }

  if (!current || !next) {
    return false
  }

  return current.layer === next.layer && current.node === next.node
}

export class ProjectionService {
  constructor(
    private readonly state: State,
    private readonly renderer: CliRenderer,
    private readonly hooks: Emitter<Hooks>,
    private readonly notify: NotificationService,
    private readonly conditions: ConditionService,
  ) {}

  public getFocusedRenderable(): Renderable | null {
    const focused = getLiveRenderer(this.renderer).currentFocusedRenderable
    if (!focused || focused.isDestroyed || !focused.focused) {
      return null
    }

    return focused
  }

  public getFocusedRenderableIfAvailable(): Renderable | null {
    if (this.renderer.isDestroyed) {
      return null
    }

    return this.getFocusedRenderable()
  }

  public setPendingSequence(next: PendingSequenceState | null): void {
    if (isSamePendingSequence(this.state.projection.pendingSequence, next)) {
      return
    }

    this.state.projection.pendingSequence = next
    this.invalidateCaches()
    this.notifyPendingSequenceChange()
    this.notify.queueStateChange()
  }

  public ensureValidPendingSequence(): PendingSequenceState | undefined {
    const pending = this.state.projection.pendingSequence
    if (!pending) {
      return undefined
    }

    const focused = this.getFocusedRenderable()
    if (!this.state.layers.layers.has(pending.layer) || !this.isLayerActiveForFocused(pending.layer, focused)) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.layerMatchesRuntimeState(pending.layer)) {
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

  public getActiveKeys(options?: ActiveKeyOptions): readonly ActiveKey[] {
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

    const focused = this.getFocusedRenderable()
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

  public getCommands(query?: CommandQuery): readonly CommandRecord[] {
    const visibility = query?.visibility ?? "reachable"
    const focused =
      query && Object.prototype.hasOwnProperty.call(query, "focused")
        ? (query.focused ?? null)
        : this.getFocusedRenderableIfAvailable()

    let commands: readonly RegisteredCommand[]
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
        this.notify.emitError("[ActionMap] Error in command query filter:", error)
      },
    })
  }

  public getResolvedCommandChain(
    command: string,
    focused: Renderable | null,
    includeRecord: boolean,
  ): { entries?: readonly ResolvedCommandEntry[]; hadError: boolean } {
    const view = this.getActiveCommandView(focused)
    const entries = this.getResolvedCommandChainFromView(view, command, focused, includeRecord)
    const hadError = (includeRecord ? view.fallbackWithRecordErrors : view.fallbackWithoutRecordErrors).has(command)

    return { entries, hadError }
  }

  public getCommandAttrs(command: string, focused: Renderable | null): Readonly<Attributes> | undefined {
    const top = this.getTopResolvedCommand(command, focused, false)
    return top?.resolved.attrs
  }

  public getTopCommandRecord(command: string, focused: Renderable | null): CommandRecord | undefined {
    const top = this.getTopResolvedCommand(command, focused, true)
    return top?.resolved.record
  }

  public nodeHasReachableBindings(node: SequenceNode, focused: Renderable | null): boolean {
    return this.hasMatchingBindings(node.reachableBindings, focused, this.getActiveCommandView(focused))
  }

  public getActiveLayers(focused: Renderable | null): RegisteredLayer[] {
    const activeLayers: RegisteredLayer[] = []

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

  public isLayerActiveForFocused(layer: RegisteredLayer, focused: Renderable | null): boolean {
    const target = layer.indexTarget
    if (target.isDestroyed) {
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

  public layerCanCacheActiveKeys(layer: RegisteredLayer): boolean {
    return !layer.hasUnkeyedMatchers && !layer.hasUnkeyedBindings
  }

  public activeLayersCanCacheActiveKeys(activeLayers: readonly RegisteredLayer[]): boolean {
    for (const layer of activeLayers) {
      if (!this.layerCanCacheActiveKeys(layer)) {
        return false
      }
    }

    return true
  }

  public layerMatchesRuntimeState(layer: RegisteredLayer): boolean {
    return this.conditions.layerMatchesRuntimeState(layer)
  }

  private forEachActivationTarget(
    focused: Renderable | null,
    visit: (target: Renderable, isFocusedTarget: boolean) => boolean | void,
  ): void {
    let current: Renderable | null = focused ?? this.renderer.root
    let isFocusedTarget = focused !== null

    while (current) {
      const shouldContinue = visit(current, isFocusedTarget)
      if (shouldContinue === false) {
        return
      }

      current = current.parent
      isFocusedTarget = false
    }
  }

  private collectSequenceStrokesFromNode(node: SequenceNode): NormalizedKeyStroke[] {
    return this.collectSequencePartsFromNode(node).map((part) => snapshotStroke(part.stroke))
  }

  private collectSequencePartsFromNode(node: SequenceNode): KeySequencePart[] {
    const nodes: SequenceNode[] = []
    let current: SequenceNode | null = node

    while (current && current.stroke) {
      nodes.push(current)
      current = current.parent
    }

    nodes.reverse()

    const focused = this.getFocusedRenderable()
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
    bindings: readonly CompiledBinding[],
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): CompiledBinding[] {
    const matches: CompiledBinding[] = []

    for (const binding of bindings) {
      if (this.conditions.matchesConditions(binding) && this.isVisibleBinding(binding, focused, activeView)) {
        matches.push(binding)
      }
    }

    return matches
  }

  private hasMatchingBindings(
    bindings: readonly CompiledBinding[],
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): boolean {
    for (const binding of bindings) {
      if (this.conditions.matchesConditions(binding) && this.isVisibleBinding(binding, focused, activeView)) {
        return true
      }
    }

    return false
  }

  private isVisibleBinding(
    binding: CompiledBinding,
    focused: Renderable | null,
    activeView: ActiveCommandView,
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
    node: SequenceNode,
    focused: Renderable | null,
    activeView: ActiveCommandView,
    reachableBindings: readonly CompiledBinding[] = this.getMatchingBindings(
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
    binding: CompiledBinding,
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): ActiveBinding {
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
    bindings: readonly CompiledBinding[],
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): ActiveBinding[] {
    return bindings.map((binding) => this.toActiveBinding(binding, focused, activeView))
  }

  private getActiveCommandAttrs(
    binding: CompiledBinding,
    focused: Renderable | null,
    activeView: ActiveCommandView,
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
    activeLayers: RegisteredLayer[],
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): readonly ActiveKey[] {
    const activeKeys = new Map<string, ActiveKeyState>()
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

    const materialized: ActiveKey[] = []
    for (const state of activeKeys.values()) {
      const activeKey = this.materializeActiveKey(state, includeBindings, includeMetadata, focused, activeView)
      if (activeKey) {
        materialized.push(activeKey)
      }
    }

    return materialized
  }

  private collectActiveKeysFromChildren(
    children: ReadonlyMap<string, SequenceNode>,
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): readonly ActiveKey[] {
    const activeKeys: ActiveKey[] = []

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
    node: SequenceNode,
    includeBindings: boolean,
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): ActiveKeySelection | undefined {
    return node.children.size > 0
      ? this.selectPrefixActiveKey(node, includeBindings, focused, activeView)
      : this.selectExactActiveKey(node, includeBindings, focused, activeView)
  }

  private selectPrefixActiveKey(
    node: SequenceNode,
    includeBindings: boolean,
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): ActiveKeySelection | undefined {
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
    node: SequenceNode,
    includeBindings: boolean,
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): ActiveKeySelection | undefined {
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
    bindings: readonly CompiledBinding[],
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): { bindings: readonly CompiledBinding[]; commandBinding?: CompiledBinding; stop: boolean } | undefined {
    const selected: CompiledBinding[] = []
    let commandBinding: CompiledBinding | undefined

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
    selection: ActiveKeySelection,
    includeBindings: boolean,
  ): ActiveKeyState {
    return {
      stroke,
      display: selection.display,
      continues: selection.continues,
      firstBinding: selection.firstBinding,
      commandBinding: selection.commandBinding,
      bindings: includeBindings && selection.bindings ? [...selection.bindings] : undefined,
    }
  }

  private updateActiveKeyState(state: ActiveKeyState, selection: ActiveKeySelection, includeBindings: boolean): void {
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
    state: ActiveKeyState,
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: Renderable | null,
    activeView: ActiveCommandView,
  ): ActiveKey | undefined {
    if (!state.commandBinding && !state.continues) {
      return undefined
    }

    const activeKey: ActiveKey = {
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
    focused: Renderable | null,
    includeRecord: boolean,
  ): ResolvedCommandEntry | undefined {
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
    activeView: ActiveCommandView,
    command: string,
    focused: Renderable | null,
    includeRecord: boolean,
  ): ResolvedCommandEntry | undefined {
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
    activeView: ActiveCommandView,
    command: string,
    focused: Renderable | null,
    includeRecord: boolean,
  ): readonly ResolvedCommandEntry[] | undefined {
    const cache = includeRecord ? activeView.resolvedWithRecordChains : activeView.resolvedWithoutRecordChains
    const cached = cache.get(command)
    if (cached) {
      return cached.length > 0 ? cached : undefined
    }

    const resolved: ResolvedCommandEntry[] = []
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

  private getActiveCommandView(focused: Renderable | null): ActiveCommandView {
    const currentFocused = this.getFocusedRenderableIfAvailable()
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (
      focused === currentFocused &&
      this.state.projection.activeCommandViewVersion === derivedStateVersion &&
      this.state.projection.activeCommandView
    ) {
      return this.state.projection.activeCommandView
    }

    const entries: LayerCommandEntry[] = []
    const reachable: LayerCommandEntry[] = []
    const reachableByName = new Map<string, LayerCommandEntry>()
    const chainsByName = new Map<string, LayerCommandEntry[]>()

    if (this.state.layers.layersWithCommands > 0) {
      for (const layer of this.getActiveLayers(focused)) {
        if (layer.commands.length === 0 || !this.layerMatchesRuntimeState(layer)) {
          continue
        }

        for (const command of layer.commands) {
          const entry: LayerCommandEntry = { layer, command }
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

    const view: ActiveCommandView = {
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

  private getRegisteredCommands(): readonly RegisteredCommand[] {
    const cacheVersion = this.state.commands.commandMetadataVersion
    if (this.state.projection.registeredCommandsCacheVersion === cacheVersion) {
      return this.state.projection.registeredCommandsCache
    }

    const layers = [...this.state.layers.layers]
    layers.sort((left, right) => left.order - right.order)

    const commands: RegisteredCommand[] = []
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
    focused: Renderable | null,
    options?: { includeRecord?: boolean },
  ): ResolvedCommandLookup {
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
      let resolved: ResolvedBindingCommand | undefined

      try {
        resolved = resolver(command, context)
      } catch (error) {
        hadError = true
        this.notify.emitError(`[ActionMap] Error in command resolver for "${command}":`, error)
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

function queryRegisteredCommands(options: QueryRegisteredCommandsOptions): readonly CommandRecord[] {
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

function commandMatchesSearch(command: RegisteredCommand, search: string, searchKeys: readonly string[]): boolean {
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

function commandMatchesNamespace(
  command: RegisteredCommand,
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

function commandMatchesFilters(
  command: RegisteredCommand,
  filters: readonly [string, CommandQueryValue][] | undefined,
  options: QueryRegisteredCommandsOptions,
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

function commandKeyMatchesSearch(command: RegisteredCommand, key: string, search: string): boolean {
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

function commandKeyMatchesQuery(
  command: RegisteredCommand,
  key: string,
  matcher: CommandQueryValue,
  options: QueryRegisteredCommandsOptions,
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

function commandKeyMatchesExact(
  command: RegisteredCommand,
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
