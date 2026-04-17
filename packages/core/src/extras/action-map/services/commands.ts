import type { ActionMap } from "../action-map.js"
import type {
  ActionMapAttributes,
  ActionMapBindingCommand,
  ActionMapCommandContext,
  ActionMapCommandDefinition,
  ActionMapCommandFieldCompiler,
  ActionMapCommandFieldContext,
  ActionMapCommandHandler,
  ActionMapCommandQuery,
  ActionMapCommandQueryValue,
  ActionMapCommandRecord,
  ActionMapCommandResolver,
  ActionMapCommandResolverContext,
  ActionMapCommandResult,
  ActionMapHooks,
  ActionMapResolvedBindingCommand,
  ActionMapRunCommandOptions,
  ActionMapRunCommandResult,
  CompiledBinding,
  RegisteredCommand,
} from "../types.js"
import type { ActionMapState } from "./state.js"
import type { NotificationService } from "./notify.js"
import type { RuntimeService } from "./runtime.js"
import { KeyEvent } from "../../../lib/KeyHandler.js"
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
  resolved?: ActionMapResolvedBindingCommand
  hadError: boolean
}

interface ActionMapCommandsOptions {
  actionMap: ActionMap
}

interface QueryRegisteredCommandsOptions {
  commands: Iterable<RegisteredCommand>
  query?: ActionMapCommandQuery
  getCommandRecord(command: RegisteredCommand): ActionMapCommandRecord
  onFilterError(error: unknown): void
}

interface NormalizeRegisteredCommandsOptions {
  commands: readonly ActionMapCommandDefinition[]
  commandFields: ReadonlyMap<string, ActionMapCommandFieldCompiler>
  hasCommand(name: string): boolean
  onError(message: string, cause?: unknown): void
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
  constructor(
    private readonly state: ActionMapState,
    private readonly notify: NotificationService,
    private readonly runtime: RuntimeService,
    private readonly hooks: Emitter<ActionMapHooks>,
    private readonly options: ActionMapCommandsOptions,
  ) {}

  public getCommands(query?: ActionMapCommandQuery): readonly ActionMapCommandRecord[] {
    if (this.state.core.destroyed) {
      return []
    }

    return queryRegisteredCommands({
      commands: this.state.commands.commands.values(),
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

  public runCommand(cmd: string, options?: ActionMapRunCommandOptions): ActionMapRunCommandResult {
    if (this.state.core.destroyed) {
      return { ok: false, reason: "error" }
    }

    let normalized: ActionMapBindingCommand | undefined

    try {
      normalized = normalizeBindingCommand(cmd)
    } catch {
      return { ok: false, reason: "invalid-args" }
    }

    if (typeof normalized !== "string") {
      return { ok: false, reason: "not-found" }
    }

    const includeRecord = options?.includeCommand === true
    let resolved: ActionMapResolvedBindingCommand | undefined

    if (!this.state.config.commandResolvers.has()) {
      const registered = this.state.commands.commands.get(normalized)
      if (!registered) {
        return { ok: false, reason: "not-found" }
      }

      resolved = this.getResolvedRegisteredCommand(registered, { includeRecord })
    } else {
      const lookup = this.resolveCommandString(normalized, { includeRecord })
      resolved = lookup.resolved
      if (!resolved) {
        if (lookup.hadError) {
          return { ok: false, reason: "error" }
        }

        return { ok: false, reason: "not-found" }
      }
    }

    const event = options?.event ?? createSyntheticCommandEvent()
    const context: ActionMapCommandContext = {
      actionMap: this.options.actionMap,
      event,
      focused: options?.focused ?? this.runtime.getFocusedRenderable(),
      target: options?.target ?? null,
      data: this.runtime.getReadonlyData(),
    }

    let result: ActionMapCommandResult
    try {
      result = resolved.run(context)
    } catch (error) {
      this.notify.emitError(`[ActionMap] Error running command "${normalized}":`, error)
      if (resolved.record) {
        return { ok: false, reason: "error", command: resolved.record }
      }

      return { ok: false, reason: "error" }
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        this.notify.emitError(`[ActionMap] Async error in command "${normalized}":`, error)
      })
      return resolved.record ? { ok: true, command: resolved.record } : { ok: true }
    }

    if (result === false) {
      if (resolved.rejectedResult) {
        return resolved.rejectedResult
      }

      if (resolved.record) {
        return { ok: false, reason: "rejected", command: resolved.record }
      }

      return { ok: false, reason: "rejected" }
    }

    return resolved.record ? { ok: true, command: resolved.record } : { ok: true }
  }

  public runBinding(
    layer: { target?: ActionMapCommandContext["target"] },
    binding: CompiledBinding,
    event: KeyEvent,
    focused: ActionMapCommandContext["focused"],
  ): boolean {
    const run = binding.run
    if (!run) {
      return false
    }

    const context: ActionMapCommandContext = {
      actionMap: this.options.actionMap,
      event,
      focused,
      target: layer.target ?? null,
      data: this.runtime.getReadonlyData(),
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

  public registerCommandResolver(resolver: ActionMapCommandResolver): () => void {
    if (this.state.core.destroyed) {
      return () => {}
    }

    return this.notify.runWithStateChangeBatch(() => {
      this.state.config.commandResolvers.append(resolver)
      this.refreshBindingCommandResolution()
      this.notify.queueStateChange()

      return () => {
        this.notify.runWithStateChangeBatch(() => {
          if (!this.state.config.commandResolvers.remove(resolver)) {
            return
          }

          this.refreshBindingCommandResolution()
          this.notify.queueStateChange()
        })
      }
    })
  }

  public registerCommands(commands: ActionMapCommandDefinition[]): () => void {
    if (this.state.core.destroyed) {
      return () => {}
    }

    return this.notify.runWithStateChangeBatch(() => {
      const normalizedCommands = normalizeRegisteredCommands({
        commands,
        commandFields: this.state.config.commandFields,
        hasCommand: (name) => this.state.commands.commands.has(name),
        onError: (message, cause) => {
          this.notify.emitError(message, cause)
        },
      })

      for (const command of normalizedCommands) {
        this.state.commands.commands.set(command.name, command)
      }

      if (normalizedCommands.length > 0) {
        this.refreshBindingCommandResolution()
        this.notify.queueStateChange()
      }

      return () => {
        this.notify.runWithStateChangeBatch(() => {
          let removed = false

          for (const command of normalizedCommands) {
            const current = this.state.commands.commands.get(command.name)
            if (current !== command) {
              continue
            }

            this.state.commands.commands.delete(command.name)
            removed = true
          }

          if (removed) {
            this.refreshBindingCommandResolution()
            this.notify.queueStateChange()
          }
        })
      }
    })
  }

  public refreshBindingCommandResolution(): void {
    for (const layer of this.state.layers.layers) {
      for (const binding of layer.compiledBindings) {
        this.resolveCompiledBindingCommand(binding)
      }
    }

    this.state.commands.commandMetadataVersion += 1
    this.runtime.ensureValidPendingSequence()
  }

  public resolveCompiledBindingCommand(binding: CompiledBinding): void {
    binding.run = undefined
    binding.commandAttrs = undefined
    binding.activeBindingCacheVersion = undefined
    binding.activeBindingCache = undefined

    const command = binding.command
    if (command === undefined) {
      return
    }

    if (typeof command === "function") {
      binding.run = command
      return
    }

    if (!this.state.config.commandResolvers.has()) {
      const registered = this.state.commands.commands.get(command)
      if (!registered) {
        this.handleUnresolvedCommand(command, binding)
        return
      }

      const resolved = this.getResolvedRegisteredCommand(registered)
      binding.run = resolved.run
      binding.commandAttrs = resolved.attrs
      return
    }

    const lookup = this.resolveCommandString(command)
    const resolved = lookup.resolved
    if (!resolved) {
      if (!lookup.hadError) {
        this.handleUnresolvedCommand(command, binding)
      }

      return
    }

    binding.run = resolved.run
    binding.commandAttrs = resolved.attrs
  }

  public getCommandRecord(command: RegisteredCommand): ActionMapCommandRecord {
    return getRegisteredCommandRecord(command)
  }

  private resolveCommandString(command: string, options?: { includeRecord?: boolean }): ResolvedCommandLookup {
    const includeRecord = options?.includeRecord === true
    const context = this.createCommandResolverContext(includeRecord)
    let hadError = false

    for (const resolver of this.state.config.commandResolvers.values()) {
      let resolved: ActionMapResolvedBindingCommand | undefined

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

    const registered = this.state.commands.commands.get(command)
    if (registered) {
      return {
        hadError,
        resolved: this.getResolvedRegisteredCommand(registered, { includeRecord }),
      }
    }

    return { hadError }
  }

  private createCommandResolverContext(includeRecord: boolean): ActionMapCommandResolverContext {
    return {
      getCommandAttrs: (name: string) => {
        return this.state.commands.commands.get(name)?.attrs
      },
      getCommandRecord: (name: string) => {
        if (!includeRecord) {
          return undefined
        }

        const registered = this.state.commands.commands.get(name)
        if (!registered) {
          return undefined
        }

        return this.getCommandRecord(registered)
      },
    }
  }

  private getResolvedRegisteredCommand(
    command: RegisteredCommand,
    options?: { includeRecord?: boolean },
  ): ActionMapResolvedBindingCommand {
    const includeRecord = options?.includeRecord === true
    if (includeRecord) {
      const existing = command.resolvedWithRecord
      if (existing) {
        return existing
      }

      const resolved: ActionMapResolvedBindingCommand = {
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

    const resolved: ActionMapResolvedBindingCommand = {
      run: this.createRegisteredCommandRunner(command),
    }

    if (command.attrs) {
      resolved.attrs = command.attrs
    }

    command.resolved = resolved
    return resolved
  }

  private createRegisteredCommandRunner(command: RegisteredCommand): ActionMapCommandHandler {
    if (command.runner) {
      return command.runner
    }

    const runner: ActionMapCommandHandler = (ctx) => {
      return command.run({
        ...ctx,
        command: this.getCommandRecord(command),
      })
    }

    command.runner = runner
    return runner
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

function queryRegisteredCommands(options: QueryRegisteredCommandsOptions): readonly ActionMapCommandRecord[] {
  const namespace = options.query?.namespace
  const normalizedSearch = options.query?.search?.trim().toLowerCase() ?? ""
  const searchKeys =
    options.query?.searchIn && options.query.searchIn.length > 0
      ? options.query.searchIn
      : DEFAULT_COMMAND_SEARCH_FIELDS
  const filter = options.query?.filter
  let filterEntries: readonly [string, ActionMapCommandQueryValue][] | undefined
  let filterPredicate: ((command: ActionMapCommandRecord) => boolean) | undefined

  if (typeof filter === "function") {
    filterPredicate = filter
  } else if (filter) {
    filterEntries = Object.entries(filter)
  }

  const results: ActionMapCommandRecord[] = []

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
      const mergedAttrs: ActionMapAttributes = {}
      const mergedFields: Record<string, unknown> = {}
      const normalizedName = normalizeCommandName(command.name)

      if (seen.has(normalizedName)) {
        options.onError(`Duplicate action map command "${normalizedName}" in the same registration batch`)
        continue
      }

      if (options.hasCommand(normalizedName)) {
        options.onError(`ActionMap command "${normalizedName}" is already registered`)
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

function createCommandFieldContext(mergedAttrs: ActionMapAttributes, fieldName: string): ActionMapCommandFieldContext {
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

function getRegisteredCommandRecord(command: RegisteredCommand): ActionMapCommandRecord {
  if (command.record) {
    return command.record
  }

  let fields = EMPTY_COMMAND_FIELDS
  if (command.fields !== EMPTY_COMMAND_FIELDS && Object.keys(command.fields).length > 0) {
    fields = snapshotDataValue(command.fields, SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS) as Readonly<
      Record<string, unknown>
    >
  }

  let record: ActionMapCommandRecord
  if (command.attrs) {
    record = Object.freeze({
      name: command.name,
      fields,
      attrs: snapshotDataValue(
        command.attrs,
        SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS,
      ) as Readonly<ActionMapAttributes>,
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
  filters: readonly [string, ActionMapCommandQueryValue][] | undefined,
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
  matcher: ActionMapCommandQueryValue,
  options: QueryRegisteredCommandsOptions,
): boolean {
  if (typeof matcher === "function") {
    let record: ActionMapCommandRecord | undefined
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
