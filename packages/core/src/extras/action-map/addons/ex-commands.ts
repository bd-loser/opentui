import type {
  ActionMapCommandDefinition,
  ActionMapCommandContext,
  ActionMapCommandRecord,
  ActionMap,
  ActionMapParsedCommand,
} from "../types.js"
import { normalizeCommandName } from "../utils.js"

const EMPTY_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})

export interface ExCommand {
  name: string
  aliases?: string[]
  nargs?: "0" | "1" | "?" | "*" | "+"
  run: (ctx: ActionMapCommandContext & { raw: string; args: string[] }) => void | Promise<void>
  [key: string]: unknown
}

function normalizeExCommandName(name: string): string {
  const normalized = normalizeCommandName(name)
  if (normalized.startsWith(":")) {
    return normalized
  }

  return `:${normalized}`
}

function parseCommandInput(input: string): ActionMapParsedCommand {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Invalid action map command: command cannot be empty")
  }

  const parts = trimmed.split(/\s+/)
  const [name, ...args] = parts
  if (!name) {
    throw new Error(`Invalid action map command "${input}"`)
  }

  return {
    input: trimmed,
    name,
    args,
  }
}

function validateCommandArgs(command: ExCommand, args: string[]): boolean {
  if (!command.nargs) {
    return true
  }

  const count = args.length
  if (command.nargs === "0") {
    return count === 0
  }

  if (command.nargs === "1") {
    return count === 1
  }

  if (command.nargs === "?") {
    return count <= 1
  }

  if (command.nargs === "*") {
    return true
  }

  if (command.nargs === "+") {
    return count >= 1
  }

  return true
}

export function registerExCommands(manager: ActionMap, commands: ExCommand[]): () => void {
  const registrations: ActionMapCommandDefinition[] = []
  const commandMap = new Map<string, ExCommand>()

  for (const command of commands) {
    const { name, aliases, run, ...fields } = command
    const names = [name, ...(aliases ?? [])]
    const registrationFields = {
      ...fields,
      aliases,
      namespace: fields.namespace ?? "excommands",
    }

    for (const name of names) {
      const normalizedName = normalizeExCommandName(name)
      commandMap.set(normalizedName, command)

      registrations.push({
        ...registrationFields,
        name: normalizedName,
        run(ctx) {
          const rawInput = (ctx as { raw?: unknown }).raw
          const raw: string = typeof rawInput === "string" ? rawInput : normalizedName
          const args = Array.isArray((ctx as { args?: unknown }).args) ? ((ctx as { args?: string[] }).args ?? []) : []

          if (!validateCommandArgs(command, args)) {
            return false
          }

          return run({
            ...ctx,
            command: ctx.command ?? { name: normalizedName, fields: EMPTY_FIELDS },
            raw,
            args,
          })
        },
      })
    }
  }

  const offCommands = manager.registerCommands(registrations)
  const offResolver = manager.registerCommandResolver((input, ctx) => {
    if (!input.startsWith(":")) {
      return undefined
    }

    const parsed = parseCommandInput(input)
    const normalizedName = normalizeExCommandName(parsed.name)
    const command = commandMap.get(normalizedName)
    if (!command) {
      return undefined
    }

    const attrs = ctx.getCommandAttrs(normalizedName)
    const record = ctx.getCommandRecord(normalizedName)
    if (!validateCommandArgs(command, parsed.args)) {
      return {
        attrs,
        record,
        rejectedResult: record
          ? { ok: false, reason: "invalid-args", command: record }
          : { ok: false, reason: "invalid-args" },
        run() {
          return false
        },
      }
    }

    return {
      attrs,
      record,
      run(baseCtx) {
        const commandView: ActionMapCommandRecord =
          record ??
          (attrs
            ? { name: normalizedName, fields: EMPTY_FIELDS, attrs }
            : { name: normalizedName, fields: EMPTY_FIELDS })
        return command.run({
          ...baseCtx,
          command: commandView,
          raw: parsed.input,
          args: parsed.args,
        })
      },
    }
  })

  return () => {
    offResolver()
    offCommands()
  }
}
