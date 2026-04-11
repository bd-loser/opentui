import type { ExCommand, KeymapCommand, KeymapManager } from "../types.js"
import { normalizeCommandName, parseCommandInput } from "../utils.js"

function normalizeExCommandName(name: string): string {
  const normalized = normalizeCommandName(name)
  if (normalized.startsWith(":")) {
    return normalized
  }

  return `:${normalized}`
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
    const { name, aliases, nargs: _nargs, run, ...attrs } = command
    const names = [name, ...(aliases ?? [])]
    for (const name of names) {
      const normalizedName = normalizeExCommandName(name)
      commandMap.set(normalizedName, command)

      registrations.push({
        ...attrs,
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
