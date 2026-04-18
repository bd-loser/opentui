import type { Attributes, CommandContext, CommandHandler, CommandRecord, RegisteredCommand, ResolvedBindingCommand } from "../types.js"
import { snapshotDataValue } from "../lib/utils.js"

const EMPTY_COMMAND_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})
const SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS = Object.freeze({
  deep: true,
  freeze: true,
  preserveNonPlainObjects: true,
})

export function getRegisteredCommandRecord(command: RegisteredCommand): CommandRecord {
  if (command.record) {
    return command.record
  }

  let fields = EMPTY_COMMAND_FIELDS
  if (command.fields !== EMPTY_COMMAND_FIELDS && Object.keys(command.fields).length > 0) {
    fields = snapshotDataValue(command.fields, SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS) as Readonly<Record<string, unknown>>
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

export function resolveRegisteredCommand(
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

  const resolved: ResolvedBindingCommand = {
    run: createRegisteredCommandRunner(command),
  }

  if (command.attrs) {
    resolved.attrs = command.attrs
  }

  command.resolved = resolved
  return resolved
}

function createRegisteredCommandRunner(command: RegisteredCommand): CommandHandler {
  if (command.runner) {
    return command.runner
  }

  const runner: CommandHandler = (ctx: CommandContext) => {
    return command.run({
      ...ctx,
      command: getRegisteredCommandRecord(command),
    })
  }

  command.runner = runner
  return runner
}
