import type { ActionMap } from "./action-map.js"
import type {
  ActionMapBindingCommand,
  ActionMapCommandContext,
  ActionMapCommandDefinition,
  ActionMapCommandHandler,
  ActionMapCommandQuery,
  ActionMapCommandResolver,
  ActionMapCommandResolverContext,
  ActionMapCommandRecord,
  ActionMapResolvedBindingCommand,
  ActionMapRunCommandOptions,
  ActionMapRunCommandResult,
  ActionMapCommandResult,
  CompiledBinding,
  RegisteredCommand,
} from "./types.js"
import { queryRegisteredCommands } from "./command-query.js"
import { getRegisteredCommandRecord, normalizeRegisteredCommands } from "./command-registry.js"
import type { ActionMapState } from "./action-map-state.js"
import type { ActionMapNotifier } from "./action-map-notify.js"
import { KeyEvent } from "../../lib/KeyHandler.js"
import { isPromiseLike, normalizeBindingCommand } from "./utils.js"

interface ResolvedCommandLookup {
  resolved?: ActionMapResolvedBindingCommand
  hadError: boolean
}

interface ActionMapCommandsOptions {
  actionMap: ActionMap
  getFocusedRenderable: () => ActionMapCommandContext["focused"]
  getReadonlyData: () => ActionMapCommandContext["data"]
  ensureValidPendingSequence: () => void
  handleUnresolvedCommand: (command: string, binding: CompiledBinding) => void
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

export class ActionMapCommands {
  constructor(
    private readonly state: ActionMapState,
    private readonly notify: ActionMapNotifier,
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
      focused: options?.focused ?? this.options.getFocusedRenderable(),
      target: options?.target ?? null,
      data: this.options.getReadonlyData(),
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
    this.options.ensureValidPendingSequence()
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
        this.options.handleUnresolvedCommand(command, binding)
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
        this.options.handleUnresolvedCommand(command, binding)
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

    for (const resolver of this.state.config.commandResolvers.snapshot()) {
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
}
