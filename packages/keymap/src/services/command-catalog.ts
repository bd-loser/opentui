import { RESERVED_COMMAND_FIELDS } from "../schema.js"
import type {
  Attributes,
  BindingCommand,
  CommandContext,
  CommandDefinition,
  CommandFieldCompiler,
  CommandFieldContext,
  CommandResolutionStatus,
  CommandQuery,
  CommandQueryValue,
  CommandRecord,
  CommandResolver,
  CommandResolverContext,
  CommandResult,
  CompiledBinding,
  KeymapEvent,
  KeymapHost,
  RegisteredCommand,
  ResolvedBindingCommand,
} from "../types.js"
import { getActiveLayersForFocused, getFocusedTargetIfAvailable } from "./primitives/active-layers.js"
import type { ConditionService } from "./conditions.js"
import { mergeAttribute } from "./primitives/field-invariants.js"
import type { NotificationService } from "./notify.js"
import type { ActiveCommandView, LayerCommandEntry, ResolvedCommandEntry, State } from "./state.js"
import { getErrorMessage, snapshotDataValue } from "./values.js"

const DEFAULT_COMMAND_SEARCH_FIELDS = ["name"] as const

const SNAPSHOT_COMMAND_METADATA_OPTIONS = Object.freeze({
  deep: true,
  preserveNonPlainObjects: true,
})

const SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS = Object.freeze({
  deep: true,
  freeze: true,
  preserveNonPlainObjects: true,
})

const EMPTY_COMMAND_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})

interface NormalizeRegisteredCommandsOptions<TTarget extends object, TEvent extends KeymapEvent> {
  commands: readonly CommandDefinition<TTarget, TEvent>[]
  commandFields: ReadonlyMap<string, CommandFieldCompiler>
  onError(code: string, error: unknown, message: string): void
}

interface QueryRegisteredCommandsOptions<TTarget extends object, TEvent extends KeymapEvent> {
  commands: Iterable<RegisteredCommand<TTarget, TEvent>>
  query?: CommandQuery<TTarget>
  getCommandRecord(command: RegisteredCommand<TTarget, TEvent>): CommandRecord
  onFilterError(error: unknown): void
}

interface CommandCatalogOptions {
  onCommandResolversChanged(): void
}

interface ResolvedCommandLookup<TTarget extends object, TEvent extends KeymapEvent> {
  resolved?: ResolvedBindingCommand<TTarget, TEvent>
  hadError: boolean
}

export function normalizeBindingCommand<TTarget extends object, TEvent extends KeymapEvent>(
  command: BindingCommand<TTarget, TEvent> | undefined,
): BindingCommand<TTarget, TEvent> | undefined {
  if (command === undefined || typeof command === "function") {
    return command
  }

  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command: command cannot be empty")
  }

  return trimmed
}

export function normalizeCommandName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command name: name cannot be empty")
  }

  if (/\s/.test(trimmed)) {
    throw new Error(`Invalid keymap command name "${name}": command names cannot contain whitespace`)
  }

  return trimmed
}

export class CommandCatalogService<TTarget extends object, TEvent extends KeymapEvent> {
  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly host: KeymapHost<TTarget, TEvent>,
    private readonly notify: NotificationService<TTarget, TEvent>,
    private readonly conditions: ConditionService<TTarget, TEvent>,
    private readonly options: CommandCatalogOptions,
  ) {}

  public normalizeCommands(
    commands: readonly CommandDefinition<TTarget, TEvent>[],
  ): RegisteredCommand<TTarget, TEvent>[] {
    return normalizeRegisteredCommands({
      commands,
      commandFields: this.state.environment.commandFields,
      onError: (code, error, message) => {
        this.notify.emitError(code, error, message)
      },
    })
  }

  public prependCommandResolver(resolver: CommandResolver<TTarget, TEvent>): () => void {
    return this.mutateCommandResolvers(() => this.state.commands.commandResolvers.prepend(resolver), resolver)
  }

  public appendCommandResolver(resolver: CommandResolver<TTarget, TEvent>): () => void {
    return this.mutateCommandResolvers(() => this.state.commands.commandResolvers.append(resolver), resolver)
  }

  public clearCommandResolvers(): void {
    if (!this.state.commands.commandResolvers.has()) {
      return
    }

    this.notify.runWithStateChangeBatch(() => {
      this.state.commands.commandResolvers.clear()
      this.state.commands.commandMetadataVersion += 1
      this.options.onCommandResolversChanged()
      this.notify.queueStateChange()
    })
  }

  public getCommands(query?: CommandQuery<TTarget>): readonly CommandRecord[] {
    const visibility = query?.visibility ?? "reachable"
    const focused =
      query && Object.prototype.hasOwnProperty.call(query, "focused")
        ? (query.focused ?? null)
        : getFocusedTargetIfAvailable(this.host)

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

  public getActiveCommandView(focused: TTarget | null): ActiveCommandView<TTarget, TEvent> {
    const currentFocused = getFocusedTargetIfAvailable(this.host)
    const derivedStateVersion = this.state.notify.derivedStateVersion

    if (
      focused === currentFocused &&
      this.state.commands.activeCommandViewVersion === derivedStateVersion &&
      this.state.commands.activeCommandView
    ) {
      return this.state.commands.activeCommandView
    }

    const entries: LayerCommandEntry<TTarget, TEvent>[] = []
    const reachable: LayerCommandEntry<TTarget, TEvent>[] = []
    const reachableByName = new Map<string, LayerCommandEntry<TTarget, TEvent>>()
    const chainsByName = new Map<string, LayerCommandEntry<TTarget, TEvent>[]>()

    if (this.state.layers.layersWithCommands > 0) {
      for (const layer of getActiveLayersForFocused(this.state.layers.targetLayers, this.host, focused)) {
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
      this.state.commands.activeCommandViewVersion = derivedStateVersion
      this.state.commands.activeCommandView = view
    }

    return view
  }

  public isBindingVisible(
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

  public getBindingCommandAttrs(
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

  public getCommandResolutionStatus(
    command: string,
    layerCommands?: ReadonlyMap<string, RegisteredCommand<TTarget, TEvent>>,
  ): CommandResolutionStatus {
    if (layerCommands?.has(command) || this.state.commands.registeredNames.has(command)) {
      return "resolved"
    }

    const lookup = this.resolveCommandWithResolvers(command, getFocusedTargetIfAvailable(this.host))
    if (lookup.resolved || lookup.hadError) {
      return lookup.resolved ? "resolved" : "error"
    }

    return "unresolved"
  }

  private mutateCommandResolvers(register: () => () => void, resolver: CommandResolver<TTarget, TEvent>): () => void {
    return this.notify.runWithStateChangeBatch(() => {
      const off = register()
      this.state.commands.commandMetadataVersion += 1
      this.options.onCommandResolversChanged()
      this.notify.queueStateChange()

      return () => {
        this.notify.runWithStateChangeBatch(() => {
          off()
          if (this.state.commands.commandResolvers.values().includes(resolver)) {
            return
          }

          this.state.commands.commandMetadataVersion += 1
          this.options.onCommandResolversChanged()
          this.notify.queueStateChange()
        })
      }
    })
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

  private getRegisteredCommands(): readonly RegisteredCommand<TTarget, TEvent>[] {
    const cacheVersion = this.state.commands.commandMetadataVersion
    if (this.state.commands.registeredCommandsCacheVersion === cacheVersion) {
      return this.state.commands.registeredCommandsCache
    }

    const layers = [...this.state.layers.layers]
    layers.sort((left, right) => left.order - right.order)

    const commands: RegisteredCommand<TTarget, TEvent>[] = []
    for (const layer of layers) {
      if (layer.commands.length > 0) {
        commands.push(...layer.commands)
      }
    }

    this.state.commands.registeredCommandsCacheVersion = cacheVersion
    this.state.commands.registeredCommandsCache = commands
    return commands
  }

  private resolveCommandWithResolvers(
    command: string,
    focused: TTarget | null,
    options?: { includeRecord?: boolean },
  ): ResolvedCommandLookup<TTarget, TEvent> {
    const includeRecord = options?.includeRecord === true
    const context = this.createCommandResolverContext(includeRecord, focused)

    return resolveCommandWithResolvers(command, this.state.commands.commandResolvers.values(), context, (error) => {
      this.notify.emitError("command-resolver-error", error, `[Keymap] Error in command resolver for "${command}":`)
    })
  }

  private createCommandResolverContext(includeRecord: boolean, focused: TTarget | null): CommandResolverContext {
    return {
      getCommandAttrs: (name: string) => {
        return this.getCommandAttrs(name, focused)
      },
      getCommandRecord: (name: string) => {
        if (!includeRecord) {
          return undefined
        }

        return this.getTopCommandRecord(name, focused)
      },
    }
  }
}

export function getRegisteredCommandRecord<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
): CommandRecord {
  if (command.record) {
    return command.record
  }

  let fields = EMPTY_COMMAND_FIELDS
  if (command.fields !== EMPTY_COMMAND_FIELDS && Object.keys(command.fields).length > 0) {
    fields = snapshotDataValue(command.fields, SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS) as Readonly<
      Record<string, unknown>
    >
  }

  const record = command.attrs
    ? Object.freeze({
        name: command.name,
        fields,
        attrs: snapshotDataValue(command.attrs, SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS) as Readonly<Attributes>,
      })
    : Object.freeze({
        name: command.name,
        fields,
      })

  command.record = record
  return record
}

export function resolveRegisteredCommand<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
  options?: { includeRecord?: boolean },
): ResolvedBindingCommand<TTarget, TEvent> {
  const includeRecord = options?.includeRecord === true
  if (includeRecord) {
    const existing = command.resolvedWithRecord
    if (existing) {
      return existing
    }

    const resolved: ResolvedBindingCommand<TTarget, TEvent> = {
      run: createRegisteredCommandRunner(command),
    }

    if (command.attrs) {
      resolved.attrs = command.attrs
    }

    resolved.record = getRegisteredCommandRecord(command)
    command.resolvedWithRecord = resolved
    return resolved
  }

  const existing = command.resolved
  if (existing) {
    return existing
  }

  const resolved: ResolvedBindingCommand<TTarget, TEvent> = {
    run: createRegisteredCommandRunner(command),
  }

  if (command.attrs) {
    resolved.attrs = command.attrs
  }

  command.resolved = resolved
  return resolved
}

function normalizeRegisteredCommands<TTarget extends object, TEvent extends KeymapEvent>(
  options: NormalizeRegisteredCommandsOptions<TTarget, TEvent>,
): RegisteredCommand<TTarget, TEvent>[] {
  const normalizedCommands: RegisteredCommand<TTarget, TEvent>[] = []
  const seen = new Set<string>()

  for (const command of options.commands) {
    let normalizedCommand: RegisteredCommand<TTarget, TEvent> | undefined

    try {
      const mergedAttrs: Attributes = {}
      const mergedFields: Record<string, unknown> = {}
      const normalizedName = normalizeCommandName(command.name)

      if (seen.has(normalizedName)) {
        options.onError(
          "duplicate-command",
          { command: normalizedName },
          `Duplicate keymap command "${normalizedName}" in the same layer`,
        )
        continue
      }

      for (const [fieldName, value] of Object.entries(command)) {
        if (RESERVED_COMMAND_FIELDS.has(fieldName) || value === undefined) {
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
      options.onError(
        "register-command-failed",
        error,
        getErrorMessage(error, `Failed to register keymap command "${String(command.name)}"`),
      )
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

function createRegisteredCommandRunner<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
): (ctx: CommandContext<TTarget, TEvent>) => CommandResult {
  if (command.runner) {
    return command.runner
  }

  const runner = (ctx: CommandContext<TTarget, TEvent>) => {
    return command.run({
      ...ctx,
      command: getRegisteredCommandRecord(command),
    })
  }

  command.runner = runner
  return runner
}

function resolveCommandWithResolvers<TTarget extends object, TEvent extends KeymapEvent>(
  command: string,
  resolvers: readonly CommandResolver<TTarget, TEvent>[],
  context: CommandResolverContext,
  onResolverError: (error: unknown) => void,
): ResolvedCommandLookup<TTarget, TEvent> {
  if (resolvers.length === 0) {
    return { hadError: false }
  }

  let hadError = false

  for (const resolver of resolvers) {
    let resolved: ResolvedBindingCommand<TTarget, TEvent> | undefined

    try {
      resolved = resolver(command, context)
    } catch (error) {
      hadError = true
      onResolverError(error)
      continue
    }

    if (resolved) {
      return { hadError, resolved }
    }
  }

  return { hadError }
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
