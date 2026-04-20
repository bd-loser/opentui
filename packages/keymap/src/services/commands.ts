import type { Keymap } from "../keymap.js"
import type { Emitter } from "../lib/emitter.js"
import { RESERVED_COMMAND_FIELDS } from "../schema.js"
import type {
  Attributes,
  BindingCommand,
  CommandContext,
  CommandDefinition,
  CommandFieldCompiler,
  CommandFieldContext,
  CommandResolver,
  CommandResolverContext,
  CommandResult,
  CompiledBinding,
  Hooks,
  KeymapEvent,
  RegisteredCommand,
  RegisteredLayer,
  ResolvedBindingCommand,
  RunCommandOptions,
  RunCommandResult,
} from "../types.js"
import type { NotificationService } from "./notify.js"
import { cloneKeySequence, stringifyKeySequence } from "./keys.js"
import type { ProjectionService } from "./projection.js"
import type { RuntimeService } from "./runtime.js"
import type { State } from "./state.js"
import { getErrorMessage, isPromiseLike, snapshotDataValue } from "./values.js"

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

function mergeAttribute(target: Attributes, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap attribute for "${name}" from ${source}`)
  }

  target[name] = value
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

function snapshotParsedBindingInput<TTarget extends object, TEvent extends KeymapEvent>(
  binding: import("../types.js").ParsedBindingInput<TTarget, TEvent>,
): import("../types.js").ParsedBindingInput<TTarget, TEvent> {
  return {
    ...binding,
    sequence: cloneKeySequence(binding.sequence),
  }
}

interface ResolvedCommandLookup<TTarget extends object, TEvent extends KeymapEvent> {
  resolved?: ResolvedBindingCommand<TTarget, TEvent>
  hadError: boolean
}

interface CommandExecutionResult {
  status: "handled" | "rejected" | "error"
  result: RunCommandResult
}

interface CommandsOptions<TTarget extends object, TEvent extends KeymapEvent> {
  keymap: Keymap<TTarget, TEvent>
  createCommandEvent: () => TEvent
}

interface NormalizeRegisteredCommandsOptions<TTarget extends object, TEvent extends KeymapEvent> {
  commands: readonly CommandDefinition<TTarget, TEvent>[]
  commandFields: ReadonlyMap<string, CommandFieldCompiler>
  onError(code: string, error: unknown, message: string): void
}

export class CommandService<TTarget extends object, TEvent extends KeymapEvent> {
  constructor(
    private readonly state: State<TTarget, TEvent>,
    private readonly notify: NotificationService<TTarget, TEvent>,
    private readonly runtime: RuntimeService<TTarget, TEvent>,
    private readonly projection: ProjectionService<TTarget, TEvent>,
    private readonly hooks: Emitter<Hooks<TTarget, TEvent>>,
    private readonly options: CommandsOptions<TTarget, TEvent>,
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
      this.projection.ensureValidPendingSequence()
      this.notify.queueStateChange()
    })
  }

  private mutateCommandResolvers(register: () => () => void, resolver: CommandResolver<TTarget, TEvent>): () => void {
    return this.notify.runWithStateChangeBatch(() => {
      const off = register()
      this.state.commands.commandMetadataVersion += 1
      this.projection.ensureValidPendingSequence()
      this.notify.queueStateChange()

      return () => {
        this.notify.runWithStateChangeBatch(() => {
          off()
          if (this.state.commands.commandResolvers.values().includes(resolver)) {
            return
          }

          this.state.commands.commandMetadataVersion += 1
          this.projection.ensureValidPendingSequence()
          this.notify.queueStateChange()
        })
      }
    })
  }

  public runCommand(cmd: string, options?: RunCommandOptions<TTarget, TEvent>): RunCommandResult {
    let normalized: BindingCommand<TTarget, TEvent> | undefined

    try {
      normalized = normalizeBindingCommand(cmd)
    } catch {
      return { ok: false, reason: "invalid-args" }
    }

    if (typeof normalized !== "string") {
      return { ok: false, reason: "not-found" }
    }

    const includeRecord = options?.includeCommand === true
    const focused = options?.focused ?? this.projection.getFocusedTargetIfAvailable()
    const event = options?.event ?? this.options.createCommandEvent()
    const data = this.runtime.getReadonlyData()
    const chainLookup = this.projection.getResolvedCommandChain(normalized, focused, includeRecord)
    const chain = chainLookup.entries
    let rejectedResult: RunCommandResult | undefined

    if (chain) {
      for (const entry of chain) {
        const context: CommandContext<TTarget, TEvent> = {
          keymap: this.options.keymap,
          event,
          focused,
          target: options?.target ?? entry.target ?? null,
          data,
        }

        const execution = this.executeResolvedCommand(normalized, entry.resolved, context)
        if (execution.status === "handled" || execution.status === "error") {
          return execution.result
        }

        rejectedResult = execution.result
      }
    }

    if (chainLookup.hadError) {
      return { ok: false, reason: "error" }
    }

    return rejectedResult ?? { ok: false, reason: "not-found" }
  }

  public runBinding(
    bindingLayer: RegisteredLayer<TTarget, TEvent>,
    binding: CompiledBinding<TTarget, TEvent>,
    event: TEvent,
    focused: TTarget | null,
  ): boolean {
    const data = this.runtime.getReadonlyData()

    if (binding.run) {
      const result = this.executeResolvedCommand(
        typeof binding.command === "string" ? binding.command : "<function>",
        { run: binding.run },
        {
          keymap: this.options.keymap,
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

    const chain = this.projection.getResolvedCommandChain(binding.command, focused, false).entries
    if (chain) {
      for (const entry of chain) {
        const context: CommandContext<TTarget, TEvent> = {
          keymap: this.options.keymap,
          event,
          focused,
          target: entry.target ?? bindingLayer.target ?? null,
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

  public warnIfBindingCommandIsCurrentlyUnresolved(
    binding: CompiledBinding<TTarget, TEvent>,
    layerCommands?: ReadonlyMap<string, RegisteredCommand<TTarget, TEvent>>,
  ): void {
    const command = binding.command
    if (typeof command !== "string") {
      return
    }

    if (layerCommands?.has(command)) {
      return
    }

    if (this.state.commands.registeredNames.has(command)) {
      return
    }

    const focused = this.projection.getFocusedTargetIfAvailable()
    const lookup = this.resolveCommandWithResolvers(command, focused)
    if (lookup.resolved || lookup.hadError) {
      return
    }

    this.handleUnresolvedCommand(command, binding)
  }
  public resolveCommandWithResolvers(
    command: string,
    focused: TTarget | null,
    options?: { includeRecord?: boolean },
  ): ResolvedCommandLookup<TTarget, TEvent> {
    const resolvers = this.state.commands.commandResolvers.values()
    if (resolvers.length === 0) {
      return { hadError: false }
    }

    const includeRecord = options?.includeRecord === true
    const context = this.createCommandResolverContext(includeRecord, focused)
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

  private createCommandResolverContext(includeRecord: boolean, focused: TTarget | null): CommandResolverContext {
    return {
      getCommandAttrs: (name: string) => {
        return this.projection.getCommandAttrs(name, focused)
      },
      getCommandRecord: (name: string) => {
        if (!includeRecord) {
          return undefined
        }

        return this.projection.getTopCommandRecord(name, focused)
      },
    }
  }

  private executeResolvedCommand(
    commandName: string,
    resolved: ResolvedBindingCommand<TTarget, TEvent>,
    context: CommandContext<TTarget, TEvent>,
  ): CommandExecutionResult {
    const command = resolved.record
    let result: CommandResult

    try {
      result = resolved.run(context)
    } catch (error) {
      this.notify.emitError("command-execution-error", error, `[Keymap] Error running command "${commandName}":`)
      return {
        status: "error",
        result: { ok: false, reason: "error", command },
      }
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        this.notify.emitError("async-command-error", error, `[Keymap] Async error in command "${commandName}":`)
      })

      return {
        status: "handled",
        result: { ok: true, command },
      }
    }

    if (result === false) {
      if (resolved.rejectedResult) {
        return {
          status: "rejected",
          result: resolved.rejectedResult,
        }
      }

      return {
        status: "rejected",
        result: { ok: false, reason: "rejected", command },
      }
    }

    return {
      status: "handled",
      result: { ok: true, command },
    }
  }

  private handleUnresolvedCommand(command: string, binding: CompiledBinding<TTarget, TEvent>): void {
    const sequence = stringifyKeySequence(binding.sourceBinding.sequence, { preferDisplay: true })
    const warningKey = `unresolved:${binding.sourceLayerOrder}:${binding.sourceBindingIndex}:${command}:${sequence}`

    this.notify.warnOnce(
      warningKey,
      "unresolved-command",
      {
        binding: snapshotParsedBindingInput(binding.sourceBinding),
        command,
        scope: binding.sourceScope,
        target: binding.sourceTarget,
      },
      `[Keymap] Unresolved command "${command}" for binding "${sequence}" in ${binding.sourceScope} layer`,
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

export function getRegisteredCommandRecord<TTarget extends object, TEvent extends KeymapEvent>(
  command: RegisteredCommand<TTarget, TEvent>,
): import("../types.js").CommandRecord {
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

function applyBindingEventEffects<TTarget extends object, TEvent extends KeymapEvent>(
  binding: CompiledBinding<TTarget, TEvent>,
  event: TEvent,
): void {
  if (!binding.preventDefault) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
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
