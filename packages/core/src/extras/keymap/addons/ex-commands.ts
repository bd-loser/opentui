import type { CommandDefinition, CommandContext, CommandRecord, Keymap, ParsedCommand } from "../types.js"

const EMPTY_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({})

export interface ExCommand {
  name: string
  aliases?: string[]
  nargs?: "0" | "1" | "?" | "*" | "+"
  run: (ctx: CommandContext & { raw: string; args: string[] }) => void | Promise<void>
  [key: string]: unknown
}

function normalizeExCommandName(keymap: Keymap, name: string): string {
  const normalized = keymap.normalizeCommandName(name)
  if (normalized.startsWith(":")) {
    return normalized
  }

  return `:${normalized}`
}

function parseCommandInput(input: string): ParsedCommand {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command: command cannot be empty")
  }

  const parts = trimmed.split(/\s+/)
  const [name, ...args] = parts
  if (!name) {
    throw new Error(`Invalid keymap command "${input}"`)
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

export function registerExCommands(keymap: Keymap, commands: ExCommand[]): () => void {
  const registrations: CommandDefinition[] = []
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
      const normalizedName = normalizeExCommandName(keymap, name)
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

  const offCommands = keymap.registerLayer({ scope: "global", commands: registrations })
  const offResolver = keymap.appendCommandResolver((input, ctx) => {
    if (!input.startsWith(":")) {
      return undefined
    }

    const parsed = parseCommandInput(input)
    const normalizedName = normalizeExCommandName(keymap, parsed.name)
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
        const commandView: CommandRecord =
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
