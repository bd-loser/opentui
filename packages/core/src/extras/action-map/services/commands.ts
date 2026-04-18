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
import type { ProjectionService } from "./projection.js"
import type { RuntimeService } from "./runtime.js"
import type { State } from "./state.js"
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

interface NormalizeRegisteredCommandsOptions {
  commands: readonly CommandDefinition[]
  commandFields: ReadonlyMap<string, CommandFieldCompiler>
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
    private readonly state: State,
    private readonly notify: NotificationService,
    private readonly runtime: RuntimeService,
    private readonly projection: ProjectionService,
    private readonly hooks: Emitter<Hooks>,
    private readonly options: CommandsOptions,
  ) {}

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
        this.projection.ensureValidPendingSequence()
      this.notify.queueStateChange()

      return () => {
        this.notify.runWithStateChangeBatch(() => {
          if (!this.state.config.commandResolvers.remove(resolver)) {
            return
          }

          this.state.commands.commandMetadataVersion += 1
          this.projection.ensureValidPendingSequence()
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
    const focused = options?.focused ?? this.projection.getFocusedRenderableIfAvailable()
    const event = options?.event ?? createSyntheticCommandEvent()
    const data = this.runtime.getReadonlyData()
    const chainLookup = this.projection.getResolvedCommandChain(normalized, focused, includeRecord)
    const chain = chainLookup.entries
    let rejectedResult: RunCommandResult | undefined

    if (chain) {
      for (const entry of chain) {
        const context: CommandContext = {
          actionMap: this.options.actionMap,
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

    const chain = this.projection.getResolvedCommandChain(binding.command, focused, false).entries
    if (chain) {
      for (const entry of chain) {
        const context: CommandContext = {
          actionMap: this.options.actionMap,
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

    const focused = this.projection.getFocusedRenderableIfAvailable()
    const lookup = this.resolveCommandWithResolvers(command, focused)
    if (lookup.resolved || lookup.hadError) {
      return
    }

    this.handleUnresolvedCommand(command, binding)
  }

  public getCommandRecord(command: RegisteredCommand): CommandRecord {
    return getRegisteredCommandRecord(command)
  }

  private hasRegisteredCommand(name: string): boolean {
    return this.state.commands.registeredNames.has(name)
  }

  public resolveCommandWithResolvers(
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

  public resolveRegisteredCommand(
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
    const command = resolved.record
    let result: CommandResult

    try {
      result = resolved.run(context)
    } catch (error) {
      this.notify.emitError(`[ActionMap] Error running command "${commandName}":`, error)
      return {
        status: "error",
        result: { ok: false, reason: "error", command },
      }
    }

    if (isPromiseLike(result)) {
      result.catch((error) => {
        this.notify.emitError(`[ActionMap] Async error in command "${commandName}":`, error)
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
