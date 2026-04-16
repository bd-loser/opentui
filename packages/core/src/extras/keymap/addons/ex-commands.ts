import type { KeymapCommand, KeymapCommandContext, KeymapManager, KeymapParsedCommand } from "../types.js"
import { normalizeCommandName } from "../utils.js"

export interface ExCommand {
  name: string
  aliases?: string[]
  nargs?: "0" | "1" | "?" | "*" | "+"
  run: (ctx: KeymapCommandContext & { raw: string; args: string[] }) => void | Promise<void>
  [key: string]: unknown
}

function normalizeExCommandName(name: string): string {
  const normalized = normalizeCommandName(name)
  if (normalized.startsWith(":")) {
    return normalized
  }

  return `:${normalized}`
}

function parseCommandInput(input: string): KeymapParsedCommand {
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

export function registerExCommands(manager: KeymapManager, commands: ExCommand[]): () => void {
  const registrations: KeymapCommand[] = []
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
          const raw =
            typeof (ctx as { raw?: unknown }).raw === "string" ? (ctx as { raw?: string }).raw : normalizedName
          const args = Array.isArray((ctx as { args?: unknown }).args) ? ((ctx as { args?: string[] }).args ?? []) : []

          if (!validateCommandArgs(command, args)) {
            return false
          }

          return run({
            ...ctx,
            command: ctx.command ?? { name: normalizedName },
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

    return {
      attrs,
      run(baseCtx) {
        if (!validateCommandArgs(command, parsed.args)) {
          return false
        }

        return command.run({
          ...baseCtx,
          command: attrs ? { name: normalizedName, attrs } : { name: normalizedName },
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
