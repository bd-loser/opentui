import type { ActionMapConditions } from "./action-map-conditions.js"
import type { ActionMapLayers } from "./action-map-layers.js"
import type { ActionMapNotifier } from "./action-map-notify.js"
import type { ActionMapRuntime } from "./action-map-runtime.js"
import type { ActionMapState } from "./action-map-state.js"
import type {
  ActiveKeySelection,
  ActiveKeyState,
  ActionMapActiveBinding,
  ActionMapActiveKey,
  ActionMapActiveKeyOptions,
  ActionMapAttributes,
  CompiledBinding,
  ParsedKeyPart,
  ParsedKeyStroke,
  PendingSequenceState,
  RegisteredLayer,
  RuntimeMatchable,
  SequenceNode,
} from "./types.js"
import { createParsedKeyPart, snapshotStroke, stringifyKeyStroke } from "./utils.js"

export class ActionMapProjections {
  constructor(
    private readonly state: ActionMapState,
    private readonly notify: ActionMapNotifier,
    private readonly runtime: Pick<ActionMapRuntime, "getFocusedRenderable">,
    private readonly layers: Pick<
      ActionMapLayers,
      "getActiveLayers" | "isLayerActiveForFocused" | "layerCanCacheActiveKeys" | "activeLayersCanCacheActiveKeys"
    >,
    private readonly conditions: Pick<
      ActionMapConditions,
      "matchesConditions" | "hasNoConditions" | "layerMatchesRuntimeState"
    >,
  ) {}

  public getPendingSequence(): readonly ParsedKeyStroke[] {
    if (this.state.core.destroyed) {
      return []
    }

    const projections = this.state.projections
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (projections.pendingSequenceCacheVersion === derivedStateVersion) {
      return projections.pendingSequenceCache
    }

    const pending = this.ensureValidPendingSequence()
    const canUseCache = !pending || this.layers.layerCanCacheActiveKeys(pending.layer)

    const sequence = pending ? this.collectSequenceStrokesFromNode(pending.node) : []

    if (canUseCache) {
      projections.pendingSequenceCacheVersion = derivedStateVersion
      projections.pendingSequenceCache = sequence
    }

    return sequence
  }

  public getPendingSequenceParts(): readonly ParsedKeyPart[] {
    if (this.state.core.destroyed) {
      return []
    }

    const projections = this.state.projections
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (projections.pendingSequencePartsCacheVersion === derivedStateVersion) {
      return projections.pendingSequencePartsCache
    }

    const pending = this.ensureValidPendingSequence()
    const canUseCache = !pending || this.layers.layerCanCacheActiveKeys(pending.layer)

    const parts = pending ? this.collectSequencePartsFromNode(pending.node) : []

    if (canUseCache) {
      projections.pendingSequencePartsCacheVersion = derivedStateVersion
      projections.pendingSequencePartsCache = parts
    }

    return parts
  }

  public getActiveKeys(options?: ActionMapActiveKeyOptions): readonly ActionMapActiveKey[] {
    if (this.state.core.destroyed) {
      return []
    }

    const projections = this.state.projections
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

    const focused = this.runtime.getFocusedRenderable()
    const pending = this.ensureValidPendingSequence()
    let activeLayers: RegisteredLayer[] = []
    if (!pending) {
      activeLayers = this.layers.getActiveLayers(focused)
    }

    const canUseCache = pending
      ? this.layers.layerCanCacheActiveKeys(pending.layer)
      : this.layers.activeLayersCanCacheActiveKeys(activeLayers)

    const activeKeys = pending
      ? this.collectActiveKeysFromChildren(pending.node.children, includeBindings, includeMetadata)
      : this.collectActiveKeysAtRoot(activeLayers, includeBindings, includeMetadata)

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

  public nodeHasReachableBindings(node: SequenceNode): boolean {
    return this.hasMatchingBindings(node.reachableBindings)
  }

  public collectSequenceStrokesFromNode(node: SequenceNode): ParsedKeyStroke[] {
    return this.collectSequencePartsFromNode(node).map((part) => snapshotStroke(part.stroke))
  }

  public ensureValidPendingSequence(): PendingSequenceState | undefined {
    if (!this.state.runtime.pendingSequence) {
      return undefined
    }

    const focused = this.runtime.getFocusedRenderable()

    if (
      !this.state.layers.layers.has(this.state.runtime.pendingSequence.layer) ||
      !this.layers.isLayerActiveForFocused(this.state.runtime.pendingSequence.layer, focused)
    ) {
      this.notify.setPendingSequence(null)
      return undefined
    }

    if (!this.conditions.layerMatchesRuntimeState(this.state.runtime.pendingSequence.layer)) {
      this.notify.setPendingSequence(null)
      return undefined
    }

    if (!this.nodeHasReachableBindings(this.state.runtime.pendingSequence.node)) {
      this.notify.setPendingSequence(null)
      return undefined
    }

    return this.state.runtime.pendingSequence
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
      return createParsedKeyPart(candidate.stroke!, this.getNodeDisplay(candidate), candidate.matchKey!)
    })
  }

  private getMatchingBindings(bindings: readonly CompiledBinding[]): CompiledBinding[] {
    const conditions = this.conditions
    const matches: CompiledBinding[] = []

    for (const binding of bindings) {
      if (conditions.matchesConditions(binding) && this.isVisibleBinding(binding)) {
        matches.push(binding)
      }
    }

    return matches
  }

  private hasMatchingBindings(bindings: readonly CompiledBinding[]): boolean {
    const conditions = this.conditions

    for (const binding of bindings) {
      if (conditions.matchesConditions(binding) && this.isVisibleBinding(binding)) {
        return true
      }
    }

    return false
  }

  private isVisibleBinding(binding: CompiledBinding): boolean {
    return binding.command === undefined || binding.run !== undefined
  }

  private getNodeDisplay(
    node: SequenceNode,
    reachableBindings: readonly CompiledBinding[] = this.getMatchingBindings(node.reachableBindings),
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

  private toActiveBinding(binding: CompiledBinding): ActionMapActiveBinding {
    if (binding.activeBindingCacheVersion === this.state.commands.commandMetadataVersion) {
      const cached = binding.activeBindingCache
      if (cached) {
        return cached
      }
    }

    const activeBinding: ActionMapActiveBinding = {
      sequence: binding.sequence,
      command: binding.command,
      commandAttrs: binding.commandAttrs,
      attrs: binding.attrs,
      event: binding.event,
      preventDefault: binding.preventDefault,
      fallthrough: binding.fallthrough,
    }

    binding.activeBindingCacheVersion = this.state.commands.commandMetadataVersion
    binding.activeBindingCache = activeBinding
    return activeBinding
  }

  private collectActiveBindings(bindings: readonly CompiledBinding[]): ActionMapActiveBinding[] {
    return bindings.map((binding) => this.toActiveBinding(binding))
  }

  private getActiveCommandAttrs(binding: CompiledBinding): Readonly<ActionMapAttributes> | undefined {
    return binding.commandAttrs
  }

  private collectActiveKeysAtRoot(
    activeLayers: RegisteredLayer[],
    includeBindings: boolean,
    includeMetadata: boolean,
  ): readonly ActionMapActiveKey[] {
    const conditions = this.conditions
    const activeKeys = new Map<string, ActiveKeyState>()
    const stopped = new Set<string>()
    const hasLayerConditions = this.state.layers.layersWithConditions > 0

    for (const layer of activeLayers) {
      if (hasLayerConditions && !conditions.hasNoConditions(layer) && !conditions.matchesConditions(layer)) {
        continue
      }

      for (const [bindingKey, child] of layer.root.children) {
        if (stopped.has(bindingKey)) {
          continue
        }

        const selection = this.selectActiveKey(child, includeBindings)
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

    const materialized: ActionMapActiveKey[] = []
    for (const state of activeKeys.values()) {
      const activeKey = this.materializeActiveKey(state, includeBindings, includeMetadata)
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
  ): readonly ActionMapActiveKey[] {
    const activeKeys: ActionMapActiveKey[] = []

    for (const child of children.values()) {
      const selection = this.selectActiveKey(child, includeBindings)
      if (!selection) {
        continue
      }

      const activeKey = this.materializeActiveKey(
        this.createActiveKeyState(child.stroke!, selection, includeBindings),
        includeBindings,
        includeMetadata,
      )
      if (!activeKey) {
        continue
      }

      activeKeys.push(activeKey)
    }

    return activeKeys
  }

  private selectActiveKey(node: SequenceNode, includeBindings: boolean): ActiveKeySelection | undefined {
    if (node.children.size > 0) {
      return this.selectPrefixActiveKey(node, includeBindings)
    }

    return this.selectExactActiveKey(node, includeBindings)
  }

  private selectPrefixActiveKey(node: SequenceNode, includeBindings: boolean): ActiveKeySelection | undefined {
    if (!node.stroke) {
      return undefined
    }

    const reachableBindings = this.getMatchingBindings(node.reachableBindings)
    if (reachableBindings.length === 0) {
      return undefined
    }

    const prefixBindings = this.getMatchingBindings(node.bindings)

    return {
      display: this.getNodeDisplay(node, reachableBindings),
      continues: true,
      firstBinding: prefixBindings[0],
      bindings: includeBindings && prefixBindings.length > 0 ? prefixBindings : undefined,
      stop: true,
    }
  }

  private selectExactActiveKey(node: SequenceNode, includeBindings: boolean): ActiveKeySelection | undefined {
    if (!node.stroke) {
      return undefined
    }

    const selected = this.selectActiveBindings(node.bindings)
    if (!selected) {
      return undefined
    }

    const display =
      selected.bindings.length === 1
        ? (selected.bindings[0]?.sequence[node.depth - 1]?.display ?? stringifyKeyStroke(node.stroke))
        : this.getNodeDisplay(node, selected.bindings)

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
  ): { bindings: readonly CompiledBinding[]; commandBinding?: CompiledBinding; stop: boolean } | undefined {
    const conditions = this.conditions
    const selected: CompiledBinding[] = []
    let commandBinding: CompiledBinding | undefined

    for (const binding of bindings) {
      if (!conditions.matchesConditions(binding) || !this.isVisibleBinding(binding)) {
        continue
      }

      selected.push(binding)
      if (!binding.run) {
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
  ): ActionMapActiveKey | undefined {
    if (!state.commandBinding && !state.continues) {
      return undefined
    }

    const activeKey: ActionMapActiveKey = {
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
          ? [this.toActiveBinding(state.bindings[0]!)]
          : this.collectActiveBindings(state.bindings)
    }

    if (includeMetadata) {
      const metadataBinding = state.firstBinding
      if (metadataBinding?.attrs) {
        activeKey.bindingAttrs = metadataBinding.attrs
      }

      const commandAttrs = state.commandBinding ? this.getActiveCommandAttrs(state.commandBinding) : undefined
      if (commandAttrs) {
        activeKey.commandAttrs = commandAttrs
      }
    }

    return activeKey
  }
}
