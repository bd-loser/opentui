import type {
  ActionMapAttributes,
  ActionMapCommandDefinition,
  ActionMapCommandFieldCompiler,
  ActionMapCommandFieldContext,
  ActionMapCommandRecord,
  RegisteredCommand,
} from "./types.js"
import { getErrorMessage, mergeAttribute, normalizeCommandName, snapshotDataValue } from "./utils.js"

export const RESERVED_COMMAND_FIELDS = new Set(["name", "run"])
const SNAPSHOT_COMMAND_METADATA_OPTIONS = Object.freeze({ deep: true, preserveNonPlainObjects: true })
const SNAPSHOT_FROZEN_COMMAND_METADATA_OPTIONS = Object.freeze({
  deep: true,
  freeze: true,
  preserveNonPlainObjects: true,
})

export const EMPTY_COMMAND_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})

interface NormalizeRegisteredCommandsOptions {
  commands: readonly ActionMapCommandDefinition[]
  commandFields: ReadonlyMap<string, ActionMapCommandFieldCompiler>
  hasCommand(name: string): boolean
  onError(message: string, cause?: unknown): void
}

export function normalizeRegisteredCommands(options: NormalizeRegisteredCommandsOptions): RegisteredCommand[] {
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

export function getRegisteredCommandRecord(command: RegisteredCommand): ActionMapCommandRecord {
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
