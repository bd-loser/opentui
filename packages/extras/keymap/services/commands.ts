import { KeyEvent, type Renderable } from "@opentui/core"
import type { Keymap } from "../keymap.js"
import type { Emitter } from "../lib/emitter.js"
import { RESERVED_COMMAND_FIELDS } from "../schema.js"
import {
  EMPTY_COMMAND_FIELDS,
  getErrorMessage,
  isPromiseLike,
  mergeAttribute,
  normalizeBindingCommand,
  normalizeCommandName,
  SNAPSHOT_COMMAND_METADATA_OPTIONS,
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

interface ResolvedCommandLookup {
  resolved?: ResolvedBindingCommand
  hadError: boolean
}

interface CommandExecutionResult {
  status: "handled" | "rejected" | "error"
  result: RunCommandResult
}

interface CommandsOptions {
  keymap: Keymap
}

interface NormalizeRegisteredCommandsOptions {
  commands: readonly CommandDefinition[]
  commandFields: ReadonlyMap<string, CommandFieldCompiler>
  onError(code: string, error: unknown, message: string): void
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
      onError: (code, error, message) => {
        this.notify.emitError(code, error, message)
      },
    })
  }

  public prependCommandResolver(resolver: CommandResolver): () => void {
    return this.mutateCommandResolvers(() => this.state.config.commandResolvers.prepend(resolver), resolver)
  }

  public appendCommandResolver(resolver: CommandResolver): () => void {
    return this.mutateCommandResolvers(() => this.state.config.commandResolvers.append(resolver), resolver)
  }

  public clearCommandResolvers(): void {
    if (!this.state.config.commandResolvers.has()) {
      return
    }

    this.notify.runWithStateChangeBatch(() => {
      this.state.config.commandResolvers.clear()
      this.state.commands.commandMetadataVersion += 1
      this.projection.ensureValidPendingSequence()
      this.notify.queueStateChange()
    })
  }

  private mutateCommandResolvers(register: () => () => void, resolver: CommandResolver): () => void {
    return this.notify.runWithStateChangeBatch(() => {
      const off = register()
      this.state.commands.commandMetadataVersion += 1
      this.projection.ensureValidPendingSequence()
      this.notify.queueStateChange()

      return () => {
        this.notify.runWithStateChangeBatch(() => {
          off()
          if (this.state.config.commandResolvers.values().includes(resolver)) {
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
        const context: CommandContext = {
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
        this.notify.emitError("command-resolver-error", error, `[Keymap] Error in command resolver for "${command}":`)
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

  private handleUnresolvedCommand(command: string, binding: CompiledBinding): void {
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
        options.onError(`Duplicate keymap command "${normalizedName}" in the same layer`)
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
