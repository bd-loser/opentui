import type { Renderable } from "../../../Renderable.js"
import { KeyEvent } from "../../../lib/KeyHandler.js"
import type { ActionMap } from "../action-map.js"
import type { Emitter } from "../lib/emitter.js"
import {
  getErrorMessage,
  isPromiseLike,
  mergeAttribute,
  normalizeBindingCommand,
  normalizeCommandName,
  snapshotDataValue,
  snapshotParsedBindingInput,
  stringifyKeySequence,
} from "../lib/utils.js"
import type {
  Attributes,
  BindingCommand,
  CommandContext,
  CommandDefinition,
  CommandFieldCompiler,
  CommandFieldContext,
  CommandHandler,
  CommandQuery,
  CommandQueryValue,
  CommandRecord,
  CommandResolver,
  CommandResolverContext,
  CommandResult,
  CompiledBinding,
  Hooks,
  RegisteredCommand,
  RegisteredLayer,
  ResolvedBindingCommand,
  RunCommandOptions,
  RunCommandResult,
} from "../types.js"
import type { NotificationService } from "./notify.js"
import type { RuntimeService } from "./runtime.js"
import type { State } from "./state.js"

const DEFAULT_COMMAND_SEARCH_FIELDS = ["name"] as const
const SNAPSHOT_COMMAND_METADATA_OPTIONS = Object.freeze({ deep: true, preserveNonPlainObjects: true })
const SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS = Object.freeze({
  deep: true,
  freeze: true,
  preserveNonPlainObjects: true,
})

export const RESERVED_COMMAND_FIELDS = new Set(["name", "run"])

const EMPTY_COMMAND_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})

interface ResolvedCommandLookup {
  resolved?: ResolvedBindingCommand
  hadError: boolean
}

interface CommandExecutionResult {
  status: "handled" | "rejected" | "error"
  result: RunCommandResult
}

interface CommandsOptions {
  actionMap: ActionMap
}

interface QueryRegisteredCommandsOptions {
  commands: Iterable<RegisteredCommand>
  query?: CommandQuery
  getCommandRecord(command: RegisteredCommand): CommandRecord
  onFilterError(error: unknown): void
}

interface NormalizeRegisteredCommandsOptions {
  commands: readonly CommandDefinition[]
  commandFields: ReadonlyMap<string, CommandFieldCompiler>
  onError(message: string, cause?: unknown): void
}

interface LayerCommandEntry {
  layer: RegisteredLayer
  command: RegisteredCommand
}

interface ResolvedCommandEntry {
  layer?: RegisteredLayer
  resolved: ResolvedBindingCommand
}

interface ActiveCommandView {
  entries: readonly LayerCommandEntry[]
  reachable: readonly LayerCommandEntry[]
  reachableByName: ReadonlyMap<string, LayerCommandEntry>
  chainsByName: ReadonlyMap<string, readonly LayerCommandEntry[]>
  resolvedWithoutRecordChains: Map<string, readonly ResolvedCommandEntry[]>
  resolvedWithRecordChains: Map<string, readonly ResolvedCommandEntry[]>
  fallbackWithoutRecord: Map<string, ResolvedBindingCommand | null>
  fallbackWithRecord: Map<string, ResolvedBindingCommand | null>
  fallbackWithoutRecordErrors: Set<string>
  fallbackWithRecordErrors: Set<string>
}

function createSyntheticCommandEvent(): KeyEvent {
  return new KeyEvent({
    name: "command",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "",
    number: false,
    raw: "",
    eventType: "press",
    source: "raw",
  })
}

export class CommandService {
  private activeCommandViewVersion = -1
  private activeCommandView: ActiveCommandView | undefined
  private registeredCommandsCacheVersion = -1
  private registeredCommandsCache: readonly RegisteredCommand[] = []

  constructor(
    private readonly state: State,
    private readonly notify: NotificationService,
    private readonly runtime: RuntimeService,
    private readonly hooks: Emitter<Hooks>,
    private readonly options: CommandsOptions,
  ) {}

  public getCommands(query?: CommandQuery): readonly CommandRecord[] {
    const visibility = query?.visibility ?? "reachable"
    const focused = query && Object.prototype.hasOwnProperty.call(query, "focused")
      ? (query.focused ?? null)
      : this.runtime.getFocusedRenderableIfAvailable()

    let commands: readonly RegisteredCommand[]
    if (visibility === "registered") {
      commands = this.getRegisteredCommands()
    } else {
      const view = this.getActiveCommandView(focused)
      if (visibility === "active") {
        commands = view.entries.map((entry) => entry.command)
      } else {
        commands = view.reachable.map((entry) => entry.command)
      }
    }

    return queryRegisteredCommands({
      commands,
      query,
      getCommandRecord: (command) => this.getCommandRecord(command),
      onFilterError: (error) => {
        this.notify.emitError("[ActionMap] Error in command query filter:", error)
      },
    })
  }

  public normalizeCommandName(name: string): string {
    return normalizeCommandName(name)
  }

  public normalizeCommands(commands: readonly CommandDefinition[]): RegisteredCommand[] {
    return normalizeRegisteredCommands({
      commands,
      commandFields: this.state.config.commandFields,
      onError: (message, cause) => {
        this.notify.emitError(message, cause)
      },
    })
  }

  public registerCommandResolver(resolver: CommandResolver): () => void {
    return this.notify.runWithStateChangeBatch(() => {
      this.state.config.commandResolvers.append(resolver)
      this.state.commands.commandMetadataVersion += 1
      this.runtime.ensureValidPendingSequence()
      this.notify.queueStateChange()

      return () => {
        this.notify.runWithStateChangeBatch(() => {
          if (!this.state.config.commandResolvers.remove(resolver)) {
            return
          }

          this.state.commands.commandMetadataVersion += 1
          this.runtime.ensureValidPendingSequence()
          this.notify.queueStateChange()
        })
      }
    })
  }

  public runCommand(cmd: string, options?: RunCommandOptions): RunCommandResult {
    let normalized: BindingCommand | undefined

    try {
      normalized = normalizeBindingCommand(cmd)
    } catch {
      return { ok: false, reason: "invalid-args" }
    }

    if (typeof normalized !== "string") {
      return { ok: false, reason: "not-found" }
    }

    const includeRecord = options?.includeCommand === true
    const focused = options?.focused ?? this.runtime.getFocusedRenderableIfAvailable()
    const event = options?.event ?? createSyntheticCommandEvent()
    const data = this.runtime.getReadonlyData()
    const view = this.getActiveCommandView(focused)
    const chain = this.getResolvedCommandChain(view, normalized, focused, includeRecord)
    let rejectedResult: RunCommandResult | undefined

    if (chain) {
      for (const entry of chain) {
        const context: CommandContext = {
          actionMap: this.options.actionMap,
          event,
          focused,
          target: options?.target ?? entry.layer?.target ?? null,
          data,
        }

        const execution = this.executeResolvedCommand(normalized, entry.resolved, context)
        if (execution.status === "handled" || execution.status === "error") {
          return execution.result
        }

        rejectedResult = execution.result
      }
    }

    const fallbackErrors = includeRecord ? view.fallbackWithRecordErrors : view.fallbackWithoutRecordErrors
    if (fallbackErrors.has(normalized)) {
      return { ok: false, reason: "error" }
    }

    return rejectedResult ?? { ok: false, reason: "not-found" }
  }

  public runBinding(
    bindingLayer: RegisteredLayer,
    binding: CompiledBinding,
    event: KeyEvent,
    focused: Renderable | null,
  ): boolean {
    const data = this.runtime.getReadonlyData()

    if (binding.run) {
      const result = this.executeResolvedCommand(
        typeof binding.command === "string" ? binding.command : "<function>",
        { run: binding.run },
        {
          actionMap: this.options.actionMap,
          event,
          focused,
          target: bindingLayer.target ?? null,
          data,
        },
      )

      if (result.status === "rejected") {
        return false
      }

      applyBindingEventEffects(binding, event)
      return true
    }

    if (typeof binding.command !== "string") {
      return false
    }

    const view = this.getActiveCommandView(focused)
    const chain = this.getResolvedCommandChain(view, binding.command, focused, false)
    if (chain) {
      for (const entry of chain) {
        const context: CommandContext = {
          actionMap: this.options.actionMap,
          event,
          focused,
          target: entry.layer?.target ?? bindingLayer.target ?? null,
          data,
        }

        const execution = this.executeResolvedCommand(binding.command, entry.resolved, context)
        if (execution.status === "rejected") {
          continue
        }

        applyBindingEventEffects(binding, event)
        return true
      }
    }

    return false
  }

  public canResolveCommand(command: string, focused: Renderable | null): boolean {
    const active = this.getActiveCommandView(focused).reachableByName.get(command)
    if (active) {
      return true
    }

    return this.getFallbackResolvedCommand(this.getActiveCommandView(focused), command, focused, false) !== undefined
  }

  public getCommandAttrs(command: string, focused: Renderable | null): Readonly<Attributes> | undefined {
    const top = this.getTopResolvedCommand(command, focused, false)
    return top?.resolved.attrs
  }

  public createCommandProjection(focused: Renderable | null): {
    canResolve(name: string): boolean
    getAttrs(name: string): Readonly<Attributes> | undefined
  } {
    const view = this.getActiveCommandView(focused)

    return {
      canResolve: (name) => {
        if (view.reachableByName.has(name)) {
          return true
        }

        return this.getFallbackResolvedCommand(view, name, focused, false) !== undefined
      },
      getAttrs: (name) => {
        const active = view.reachableByName.get(name)
        if (active) {
          return active.command.attrs
        }

        const fallback = this.getFallbackResolvedCommand(view, name, focused, false)
        return fallback?.resolved.attrs
      },
    }
  }

  public warnIfBindingCommandIsCurrentlyUnresolved(
    binding: CompiledBinding,
    layerCommands?: ReadonlyMap<string, RegisteredCommand>,
  ): void {
    const command = binding.command
    if (typeof command !== "string") {
      return
    }

    if (layerCommands?.has(command)) {
      return
    }

    if (this.hasRegisteredCommand(command)) {
      return
    }

    const focused = this.runtime.getFocusedRenderableIfAvailable()
    const lookup = this.resolveCommandWithResolvers(command, focused)
    if (lookup.resolved || lookup.hadError) {
      return
    }

    this.handleUnresolvedCommand(command, binding)
  }

  public getCommandRecord(command: RegisteredCommand): CommandRecord {
    return getRegisteredCommandRecord(command)
  }

  private getTopResolvedCommand(
    command: string,
    focused: Renderable | null,
    includeRecord: boolean,
  ): ResolvedCommandEntry | undefined {
    const view = this.getActiveCommandView(focused)
    const active = view.reachableByName.get(command)
    if (active) {
      return {
        layer: active.layer,
        resolved: this.getResolvedRegisteredCommand(active.command, { includeRecord }),
      }
    }

    return this.getFallbackResolvedCommand(view, command, focused, includeRecord)
  }

  private getFallbackResolvedCommand(
    view: ActiveCommandView,
    command: string,
    focused: Renderable | null,
    includeRecord: boolean,
  ): ResolvedCommandEntry | undefined {
    const cache = includeRecord ? view.fallbackWithRecord : view.fallbackWithoutRecord
    const errorCache = includeRecord ? view.fallbackWithRecordErrors : view.fallbackWithoutRecordErrors
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

  private getResolvedCommandChain(
    view: ActiveCommandView,
    command: string,
    focused: Renderable | null,
    includeRecord: boolean,
  ): readonly ResolvedCommandEntry[] | undefined {
    const cache = includeRecord ? view.resolvedWithRecordChains : view.resolvedWithoutRecordChains
    const cached = cache.get(command)
    if (cached) {
      return cached.length > 0 ? cached : undefined
    }

    const resolved: ResolvedCommandEntry[] = []
    const activeChain = view.chainsByName.get(command)
    if (activeChain) {
      for (const entry of activeChain) {
        resolved.push({
          layer: entry.layer,
          resolved: this.getResolvedRegisteredCommand(entry.command, { includeRecord }),
        })
      }
    }

    const fallback = this.getFallbackResolvedCommand(view, command, focused, includeRecord)
    if (fallback) {
      resolved.push(fallback)
    }

    cache.set(command, resolved)
    return resolved.length > 0 ? resolved : undefined
  }

  private getActiveCommandView(focused: Renderable | null): ActiveCommandView {
    const currentFocused = this.runtime.getFocusedRenderableIfAvailable()
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (focused === currentFocused && this.activeCommandViewVersion === derivedStateVersion && this.activeCommandView) {
      return this.activeCommandView
    }

    const entries: LayerCommandEntry[] = []
    const reachable: LayerCommandEntry[] = []
    const reachableByName = new Map<string, LayerCommandEntry>()
    const chainsByName = new Map<string, LayerCommandEntry[]>()

    if (this.state.layers.layersWithCommands > 0) {
      const activeLayers = this.runtime.getActiveLayers(focused)

      for (const layer of activeLayers) {
        if (layer.commands.length === 0) {
          continue
        }

        if (!this.runtime.layerMatchesRuntimeState(layer)) {
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
      resolvedWithoutRecordChains: new Map<string, readonly ResolvedCommandEntry[]>(),
      resolvedWithRecordChains: new Map<string, readonly ResolvedCommandEntry[]>(),
      fallbackWithoutRecord: new Map<string, ResolvedBindingCommand | null>(),
      fallbackWithRecord: new Map<string, ResolvedBindingCommand | null>(),
      fallbackWithoutRecordErrors: new Set<string>(),
      fallbackWithRecordErrors: new Set<string>(),
    }

    if (focused === currentFocused) {
      this.activeCommandViewVersion = derivedStateVersion
      this.activeCommandView = view
    }

    return view
  }

  private getRegisteredCommands(): readonly RegisteredCommand[] {
    const cacheVersion = this.state.commands.commandMetadataVersion
    if (this.registeredCommandsCacheVersion === cacheVersion) {
      return this.registeredCommandsCache
    }

    const layers = [...this.state.layers.layers]
    layers.sort((left, right) => left.order - right.order)

    const commands: RegisteredCommand[] = []
    for (const layer of layers) {
      if (layer.commands.length === 0) {
        continue
      }

      commands.push(...layer.commands)
    }

    this.registeredCommandsCacheVersion = cacheVersion
    this.registeredCommandsCache = commands
    return commands
  }

  private hasRegisteredCommand(name: string): boolean {
    return this.state.commands.registeredNames.has(name)
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
    const context = this.createCommandResolverContext(includeRecord, focused)
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

  private createCommandResolverContext(includeRecord: boolean, focused: Renderable | null): CommandResolverContext {
    return {
      getCommandAttrs: (name: string) => {
        return this.getCommandAttrs(name, focused)
      },
      getCommandRecord: (name: string) => {
        if (!includeRecord) {
          return undefined
        }

        const top = this.getTopResolvedCommand(name, focused, true)
        return top?.resolved.record
      },
    }
  }

  private getResolvedRegisteredCommand(
    command: RegisteredCommand,
    options?: { includeRecord?: boolean },
  ): ResolvedBindingCommand {
    const includeRecord = options?.includeRecord === true
    if (includeRecord) {
      const existing = command.resolvedWithRecord
      if (existing) {
        return existing
      }

      const resolved: ResolvedBindingCommand = {
        run: this.createRegisteredCommandRunner(command),
      }

      if (command.attrs) {
        resolved.attrs = command.attrs
      }

      resolved.record = this.getCommandRecord(command)
      command.resolvedWithRecord = resolved
      return resolved
    }

    const existing = command.resolved
    if (existing) {
      return existing
    }

    const resolved: ResolvedBindingCommand = {
      run: this.createRegisteredCommandRunner(command),
    }

    if (command.attrs) {
      resolved.attrs = command.attrs
    }

    command.resolved = resolved
    return resolved
  }

  private createRegisteredCommandRunner(command: RegisteredCommand): CommandHandler {
    if (command.runner) {
      return command.runner
    }

    const runner: CommandHandler = (ctx) => {
      return command.run({
        ...ctx,
        command: this.getCommandRecord(command),
      })
    }

    command.runner = runner
    return runner
  }

  private executeResolvedCommand(
    commandName: string,
    resolved: ResolvedBindingCommand,
    context: CommandContext,
  ): CommandExecutionResult {
    let result: CommandResult

    try {
      result = resolved.run(context)
    } catch (error) {
      this.notify.emitError(`[ActionMap] Error running command "${commandName}":`, error)
      if (resolved.record) {
        return {
          status: "error",
          result: { ok: false, reason: "error", command: resolved.record },
        }
      }

      return {
        status: "error",
        result: { ok: false, reason: "error" },
      }
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        this.notify.emitError(`[ActionMap] Async error in command "${commandName}":`, error)
      })

      if (resolved.record) {
        return {
          status: "handled",
          result: { ok: true, command: resolved.record },
        }
      }

      return {
        status: "handled",
        result: { ok: true },
      }
    }

    if (result === false) {
      if (resolved.rejectedResult) {
        return {
          status: "rejected",
          result: resolved.rejectedResult,
        }
      }

      if (resolved.record) {
        return {
          status: "rejected",
          result: { ok: false, reason: "rejected", command: resolved.record },
        }
      }

      return {
        status: "rejected",
        result: { ok: false, reason: "rejected" },
      }
    }

    if (resolved.record) {
      return {
        status: "handled",
        result: { ok: true, command: resolved.record },
      }
    }

    return {
      status: "handled",
      result: { ok: true },
    }
  }

  private handleUnresolvedCommand(command: string, binding: CompiledBinding): void {
    const sequence = stringifyKeySequence(binding.sourceBinding.sequence, { preferDisplay: true })
    const warningKey = `unresolved:${binding.sourceLayerOrder}:${binding.sourceBindingIndex}:${command}:${sequence}`

    this.notify.warnOnce(
      warningKey,
      `[ActionMap] Unresolved command "${command}" for binding "${sequence}" in ${binding.sourceScope} layer`,
    )

    if (!this.hooks.has("unresolvedCommand")) {
      return
    }

    this.hooks.emit("unresolvedCommand", {
      command,
      binding: snapshotParsedBindingInput(binding.sourceBinding),
      scope: binding.sourceScope,
      target: binding.sourceTarget,
    })
  }
}

function applyBindingEventEffects(binding: CompiledBinding, event: KeyEvent): void {
  if (!binding.preventDefault) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
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

function normalizeRegisteredCommands(options: NormalizeRegisteredCommandsOptions): RegisteredCommand[] {
  const normalizedCommands: RegisteredCommand[] = []
  const seen = new Set<string>()

  for (const command of options.commands) {
    let normalizedCommand: RegisteredCommand | undefined

    try {
      const mergedAttrs: Attributes = {}
      const mergedFields: Record<string, unknown> = {}
      const normalizedName = normalizeCommandName(command.name)

      if (seen.has(normalizedName)) {
        options.onError(`Duplicate action map command "${normalizedName}" in the same layer`)
        continue
      }

      for (const [fieldName, value] of Object.entries(command)) {
        if (RESERVED_COMMAND_FIELDS.has(fieldName)) {
          continue
        }

        if (value === undefined) {
          continue
        }

        mergedFields[fieldName] = snapshotDataValue(value, SNAPSHOT_COMMAND_METADATA_OPTIONS)

        const compiler = options.commandFields.get(fieldName)
        if (!compiler) {
          continue
        }

        compiler(value, createCommandFieldContext(mergedAttrs, fieldName))
      }

      const attrs = Object.keys(mergedAttrs).length === 0 ? undefined : Object.freeze(mergedAttrs)
      const fields = Object.keys(mergedFields).length === 0 ? EMPTY_COMMAND_FIELDS : Object.freeze(mergedFields)

      normalizedCommand = {
        name: normalizedName,
        fields,
        run: command.run,
      }

      if (attrs) {
        normalizedCommand.attrs = attrs
      }
    } catch (error) {
      options.onError(getErrorMessage(error, `Failed to register action map command "${String(command.name)}"`), error)
      continue
    }

    seen.add(normalizedCommand.name)
    normalizedCommands.push(normalizedCommand)
  }

  return normalizedCommands
}

function createCommandFieldContext(mergedAttrs: Attributes, fieldName: string): CommandFieldContext {
  return {
    attr(name, attributeValue) {
      mergeAttribute(
        mergedAttrs,
        name,
        snapshotDataValue(attributeValue, SNAPSHOT_COMMAND_METADATA_OPTIONS),
        `field ${fieldName}`,
      )
    },
  }
}

function getRegisteredCommandRecord(command: RegisteredCommand): CommandRecord {
  if (command.record) {
    return command.record
  }

  let fields = EMPTY_COMMAND_FIELDS
  if (command.fields !== EMPTY_COMMAND_FIELDS && Object.keys(command.fields).length > 0) {
    fields = snapshotDataValue(command.fields, SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS) as Readonly<Record<string, unknown>>
  }

  let record: CommandRecord
  if (command.attrs) {
    record = Object.freeze({
      name: command.name,
      fields,
      attrs: snapshotDataValue(command.attrs, SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS) as Readonly<Attributes>,
    })
  } else {
    record = Object.freeze({
      name: command.name,
      fields,
    })
  }

  command.record = record
  return record
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
