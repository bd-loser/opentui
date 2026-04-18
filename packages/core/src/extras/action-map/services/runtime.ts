import type { Renderable } from "../../../Renderable.js"
import type { CliRenderer } from "../../../renderer.js"
import type { CommandService } from "./commands.js"
import type { ConditionService } from "./conditions.js"
import type { NotificationService } from "./notify.js"
import type { State } from "./state.js"
import type {
  ActiveKeySelection,
  ActiveKeyState,
  ActiveBinding,
  ActiveKey,
  ActiveKeyOptions,
  Attributes,
  EventData,
  Hooks,
  CompiledBinding,
  ParsedKeyPart,
  ParsedKeyStroke,
  PendingSequenceState,
  RegisteredLayer,
  SequenceNode,
} from "../types.js"
import type { Emitter } from "../lib/emitter.js"
import { createParsedKeyPart, snapshotStroke, stringifyKeyStroke } from "../lib/utils.js"

type CommandProjection = ReturnType<CommandService["createCommandProjection"]>

function getLiveRenderer(renderer: CliRenderer): CliRenderer {
  if (renderer.isDestroyed) {
    throw new Error("Cannot use an action map after its renderer was destroyed")
  }

  return renderer
}

export class RuntimeService {
  private commands: CommandService | undefined

  constructor(
    private readonly state: State,
    private readonly renderer: CliRenderer,
    private readonly hooks: Emitter<Hooks>,
    private readonly notify: NotificationService,
    private readonly conditions: ConditionService,
  ) {}

  public connectCommands(commands: CommandService): void {
    this.commands = commands
  }

  public getFocusedRenderable(): Renderable | null {
    const focused = getLiveRenderer(this.renderer).currentFocusedRenderable
    if (!focused) {
      return null
    }

    if (focused.isDestroyed) {
      return null
    }

    if (!focused.focused) {
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

  public getData(name: string): unknown {
    return this.state.runtime.data[name]
  }

  public setData(name: string, value: unknown): void {
    this.notify.runWithStateChangeBatch(() => {
      if (value === undefined) {
        if (!(name in this.state.runtime.data)) {
          return
        }

        delete this.state.runtime.data[name]
        this.state.runtime.dataVersion += 1
        this.conditions.invalidateRuntimeConditionKey(name)
        this.ensureValidPendingSequence()
        this.notify.queueStateChange()
        return
      }

      if (Object.is(this.state.runtime.data[name], value)) {
        return
      }

      this.state.runtime.data[name] = value
      this.state.runtime.dataVersion += 1
      this.conditions.invalidateRuntimeConditionKey(name)
      this.ensureValidPendingSequence()
      this.notify.queueStateChange()
    })
  }

  public getReadonlyData(): Readonly<EventData> {
    if (this.state.runtime.readonlyDataVersion === this.state.runtime.dataVersion) {
      return this.state.runtime.readonlyData
    }

    this.state.runtime.readonlyData = Object.freeze({ ...this.state.runtime.data })
    this.state.runtime.readonlyDataVersion = this.state.runtime.dataVersion
    return this.state.runtime.readonlyData
  }

  public setPendingSequence(next: PendingSequenceState | null): void {
    if (isSamePendingSequence(this.state.runtime.pendingSequence, next)) {
      return
    }

    this.state.runtime.pendingSequence = next
    this.invalidateDerivedStateCaches()
    this.notifyPendingSequenceChange()
    this.notify.queueStateChange()
  }

  public ensureValidPendingSequence(): PendingSequenceState | undefined {
    if (!this.state.runtime.pendingSequence) {
      return undefined
    }

    const focused = this.getFocusedRenderable()

    if (
      !this.state.layers.layers.has(this.state.runtime.pendingSequence.layer) ||
      !this.isLayerActiveForFocused(this.state.runtime.pendingSequence.layer, focused)
    ) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.conditions.layerMatchesRuntimeState(this.state.runtime.pendingSequence.layer)) {
      this.setPendingSequence(null)
      return undefined
    }

    if (!this.nodeHasReachableBindings(this.state.runtime.pendingSequence.node, focused)) {
      this.setPendingSequence(null)
      return undefined
    }

    return this.state.runtime.pendingSequence
  }

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    const projections = this.state.runtime
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (projections.pendingSequenceCacheVersion === derivedStateVersion) {
      return projections.pendingSequenceCache
    }

    const pending = this.ensureValidPendingSequence()
    const canUseCache = !pending || this.layerCanCacheActiveKeys(pending.layer)

    const sequence = pending ? this.collectSequenceStrokesFromNode(pending.node) : []

    if (canUseCache) {
      projections.pendingSequenceCacheVersion = derivedStateVersion
      projections.pendingSequenceCache = sequence
    }

    return sequence
  }

  public getPendingSequenceParts(): readonly ParsedKeyPart[] {
    const projections = this.state.runtime
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (projections.pendingSequencePartsCacheVersion === derivedStateVersion) {
      return projections.pendingSequencePartsCache
    }

    const pending = this.ensureValidPendingSequence()
    const canUseCache = !pending || this.layerCanCacheActiveKeys(pending.layer)

    const parts = pending ? this.collectSequencePartsFromNode(pending.node) : []

    if (canUseCache) {
      projections.pendingSequencePartsCacheVersion = derivedStateVersion
      projections.pendingSequencePartsCache = parts
    }

    return parts
  }

  public getActiveKeys(options?: ActiveKeyOptions): readonly ActiveKey[] {
    const projections = this.state.runtime
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
    const commandProjection = this.commands?.createCommandProjection(focused)
    const pending = this.ensureValidPendingSequence()
    let activeLayers: RegisteredLayer[] = []
    if (!pending) {
      activeLayers = this.getActiveLayers(focused)
    }

    const canUseCache = pending
      ? this.layerCanCacheActiveKeys(pending.layer)
      : this.activeLayersCanCacheActiveKeys(activeLayers)

    const activeKeys = pending
      ? this.collectActiveKeysFromChildren(pending.node.children, includeBindings, includeMetadata, focused, commandProjection)
      : this.collectActiveKeysAtRoot(activeLayers, includeBindings, includeMetadata, focused, commandProjection)

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

  public collectSequenceStrokesFromNode(node: SequenceNode): ParsedKeyStroke[] {
    return this.collectSequencePartsFromNode(node).map((part) => snapshotStroke(part.stroke))
  }

  public nodeHasReachableBindings(node: SequenceNode, focused: Renderable | null): boolean {
    return this.hasMatchingBindings(node.reachableBindings, focused)
  }

  public getActiveLayers(focused: Renderable | null): RegisteredLayer[] {
    const activeLayers: RegisteredLayer[] = []

    if (focused) {
      let current: Renderable | null = focused
      let isFocusedTarget = true

      while (current) {
        const bucket = this.state.layers.targetLayers.get(current)
        if (bucket) {
          if (isFocusedTarget) {
            activeLayers.push(...bucket.focusLayers)
          }

          activeLayers.push(...bucket.focusWithinLayers)
        }

        current = current.parent
        isFocusedTarget = false
      }
    }

    activeLayers.push(...this.state.layers.globalLayers)

    return activeLayers
  }

  public isLayerActiveForFocused(layer: RegisteredLayer, focused: Renderable | null): boolean {
    if (layer.scope === "global") {
      return true
    }

    const target = layer.target
    if (!target || target.isDestroyed || !focused) {
      return false
    }

    if (layer.scope === "focus") {
      return target === focused
    }

    let current: Renderable | null = focused
    while (current) {
      if (current === target) {
        return true
      }

      current = current.parent
    }

    return false
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

  private collectSequencePartsFromNode(node: SequenceNode): ParsedKeyPart[] {
    const nodes: SequenceNode[] = []
    let current: SequenceNode | null = node

    while (current && current.stroke) {
      nodes.push(current)
      current = current.parent
    }

    nodes.reverse()

    return nodes.map((candidate) => {
      return createParsedKeyPart(candidate.stroke!, this.getNodeDisplay(candidate, this.getFocusedRenderable()), candidate.matchKey!)
    })
  }

  private getMatchingBindings(
    bindings: readonly CompiledBinding[],
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): CompiledBinding[] {
    const conditions = this.conditions
    const matches: CompiledBinding[] = []

    for (const binding of bindings) {
      if (conditions.matchesConditions(binding) && this.isVisibleBinding(binding, focused, commandProjection)) {
        matches.push(binding)
      }
    }

    return matches
  }

  private hasMatchingBindings(
    bindings: readonly CompiledBinding[],
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): boolean {
    const conditions = this.conditions

    for (const binding of bindings) {
      if (conditions.matchesConditions(binding) && this.isVisibleBinding(binding, focused, commandProjection)) {
        return true
      }
    }

    return false
  }

  private isVisibleBinding(
    binding: CompiledBinding,
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): boolean {
    if (binding.command === undefined) {
      return true
    }

    if (binding.run) {
      return true
    }

    if (typeof binding.command !== "string") {
      return false
    }

    if (commandProjection) {
      return commandProjection.canResolve(binding.command)
    }

    return this.commands?.canResolveCommand(binding.command, focused) ?? false
  }

  private getNodeDisplay(
    node: SequenceNode,
    focused: Renderable | null,
    reachableBindings: readonly CompiledBinding[] = this.getMatchingBindings(node.reachableBindings, focused),
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
    commandProjection?: CommandProjection,
  ): ActiveBinding {
    return {
      sequence: binding.sequence,
      command: binding.command,
      commandAttrs: this.getActiveCommandAttrs(binding, focused, commandProjection),
      attrs: binding.attrs,
      event: binding.event,
      preventDefault: binding.preventDefault,
      fallthrough: binding.fallthrough,
    }
  }

  private collectActiveBindings(
    bindings: readonly CompiledBinding[],
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): ActiveBinding[] {
    return bindings.map((binding) => this.toActiveBinding(binding, focused, commandProjection))
  }

  private getActiveCommandAttrs(
    binding: CompiledBinding,
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): Readonly<Attributes> | undefined {
    if (typeof binding.command !== "string") {
      return undefined
    }

    if (commandProjection) {
      return commandProjection.getAttrs(binding.command)
    }

    return this.commands?.getCommandAttrs(binding.command, focused)
  }

  private collectActiveKeysAtRoot(
    activeLayers: RegisteredLayer[],
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): readonly ActiveKey[] {
    const conditions = this.conditions
    const activeKeys = new Map<string, ActiveKeyState>()
    const stopped = new Set<string>()
    const hasLayerConditions = this.state.layers.layersWithConditions > 0

    for (const layer of activeLayers) {
      if (layer.root.children.size === 0) {
        continue
      }

      if (hasLayerConditions && !conditions.hasNoConditions(layer) && !conditions.matchesConditions(layer)) {
        continue
      }

      for (const [bindingKey, child] of layer.root.children) {
        if (stopped.has(bindingKey)) {
          continue
        }

        const selection = this.selectActiveKey(child, includeBindings, focused, commandProjection)
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
      const activeKey = this.materializeActiveKey(state, includeBindings, includeMetadata, focused, commandProjection)
      if (!activeKey) {
        continue
      }

      materialized.push(activeKey)
    }

    return materialized
  }

  private collectActiveKeysFromChildren(
    children: ReadonlyMap<string, SequenceNode>,
    includeBindings: boolean,
    includeMetadata: boolean,
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): readonly ActiveKey[] {
    const activeKeys: ActiveKey[] = []

    for (const child of children.values()) {
      const selection = this.selectActiveKey(child, includeBindings, focused, commandProjection)
      if (!selection) {
        continue
      }

      const activeKey = this.materializeActiveKey(
        this.createActiveKeyState(child.stroke!, selection, includeBindings),
        includeBindings,
        includeMetadata,
        focused,
        commandProjection,
      )
      if (!activeKey) {
        continue
      }

      activeKeys.push(activeKey)
    }

    return activeKeys
  }

  private selectActiveKey(
    node: SequenceNode,
    includeBindings: boolean,
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): ActiveKeySelection | undefined {
    if (node.children.size > 0) {
      return this.selectPrefixActiveKey(node, includeBindings, focused, commandProjection)
    }

    return this.selectExactActiveKey(node, includeBindings, focused, commandProjection)
  }

  private selectPrefixActiveKey(
    node: SequenceNode,
    includeBindings: boolean,
    focused: Renderable | null,
    commandProjection?: CommandProjection,
  ): ActiveKeySelection | undefined {
    if (!node.stroke) {
      return undefined
    }

    const reachableBindings = this.getMatchingBindings(node.reachableBindings, focused, commandProjection)
    if (reachableBindings.length === 0) {
      return undefined
    }

    const prefixBindings = this.getMatchingBindings(node.bindings, focused, commandProjection)

    return {
      display: this.getNodeDisplay(node, focused, reachableBindings),
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
    commandProjection?: CommandProjection,
  ): ActiveKeySelection | undefined {
    if (!node.stroke) {
      return undefined
    }

    const selected = this.selectActiveBindings(node.bindings, focused, commandProjection)
    if (!selected) {
      return undefined
    }

    const display =
      selected.bindings.length === 1
        ? (selected.bindings[0]?.sequence[node.depth - 1]?.display ?? stringifyKeyStroke(node.stroke))
        : this.getNodeDisplay(node, focused, selected.bindings)

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
    commandProjection?: CommandProjection,
  ): { bindings: readonly CompiledBinding[]; commandBinding?: CompiledBinding; stop: boolean } | undefined {
    const conditions = this.conditions
    const selected: CompiledBinding[] = []
    let commandBinding: CompiledBinding | undefined

    for (const binding of bindings) {
      if (!conditions.matchesConditions(binding) || !this.isVisibleBinding(binding, focused, commandProjection)) {
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
    stroke: ParsedKeyStroke,
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
    commandProjection?: CommandProjection,
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
          ? [this.toActiveBinding(state.bindings[0]!, focused, commandProjection)]
          : this.collectActiveBindings(state.bindings, focused, commandProjection)
    }

    if (includeMetadata) {
      const metadataBinding = state.firstBinding
      if (metadataBinding?.attrs) {
        activeKey.bindingAttrs = metadataBinding.attrs
      }

      const commandAttrs = state.commandBinding
        ? this.getActiveCommandAttrs(state.commandBinding, focused, commandProjection)
        : undefined
      if (commandAttrs) {
        activeKey.commandAttrs = commandAttrs
      }
    }

    return activeKey
  }

  private invalidateDerivedStateCaches(): void {
    this.state.runtime.pendingSequenceCacheVersion = -1
    this.state.runtime.pendingSequencePartsCacheVersion = -1
    this.state.runtime.activeKeysPlainCacheVersion = -1
    this.state.runtime.activeKeysBindingsCacheVersion = -1
    this.state.runtime.activeKeysMetadataCacheVersion = -1
    this.state.runtime.activeKeysBindingsAndMetadataCacheVersion = -1
  }

  private notifyPendingSequenceChange(): void {
    if (!this.hooks.has("pendingSequence")) {
      return
    }

    this.hooks.emit(
      "pendingSequence",
      this.state.runtime.pendingSequence
        ? this.collectSequenceStrokesFromNode(this.state.runtime.pendingSequence.node)
        : [],
    )
  }
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
