import type { ExCommand, KeymapCommand, KeymapManager } from "../core.js"
import { normalizeCommandName } from "../utils.js"

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

  for (const command of commands) {
    const { name, aliases, nargs: _nargs, run, ...attrs } = command
    const names = [name, ...(aliases ?? [])]
    for (const name of names) {
      const normalizedName = normalizeExCommandName(name)
      registrations.push({
        ...attrs,
        name: normalizedName,
        run(ctx) {
          if (!validateCommandArgs(command, ctx.command.args)) {
            return false
          }

          return run({
            ...ctx,
            raw: ctx.command.input,
            args: ctx.command.args,
          })
        },
      })
    }
  }

  return manager.registerCommands(registrations)
}
