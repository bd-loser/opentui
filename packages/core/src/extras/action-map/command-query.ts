import type {
  ActionMapCommandQuery,
  ActionMapCommandQueryValue,
  ActionMapCommandRecord,
  RegisteredCommand,
} from "./types.js"

const DEFAULT_COMMAND_SEARCH_FIELDS = ["name"] as const

interface QueryRegisteredCommandsOptions {
  commands: Iterable<RegisteredCommand>
  query?: ActionMapCommandQuery
  getCommandRecord(command: RegisteredCommand): ActionMapCommandRecord
  onFilterError(error: unknown): void
}

export function queryRegisteredCommands(options: QueryRegisteredCommandsOptions): readonly ActionMapCommandRecord[] {
  const namespace = options.query?.namespace
  const normalizedSearch = options.query?.search?.trim().toLowerCase() ?? ""
  const searchKeys =
    options.query?.searchIn && options.query.searchIn.length > 0
      ? options.query.searchIn
      : DEFAULT_COMMAND_SEARCH_FIELDS
  const filter = options.query?.filter
  let filterEntries: readonly [string, ActionMapCommandQueryValue][] | undefined
  let filterPredicate: ((command: ActionMapCommandRecord) => boolean) | undefined

  if (typeof filter === "function") {
    filterPredicate = filter
  } else if (filter) {
    filterEntries = Object.entries(filter)
  }

  const results: ActionMapCommandRecord[] = []

  for (const command of options.commands) {
    if (!commandMatchesNamespace(command, namespace)) {
      continue
    }

    if (!commandMatchesSearch(command, normalizedSearch, searchKeys)) {
      continue
    }

    if (!commandMatchesFilters(command, filterEntries, options)) {
      continue
    }

    const record = options.getCommandRecord(command)

    if (filterPredicate) {
      let matches = false

      try {
        matches = filterPredicate(record)
      } catch (error) {
        options.onFilterError(error)
        continue
      }

      if (!matches) {
        continue
      }
    }

    results.push(record)
  }

  return results
}

function commandMatchesSearch(command: RegisteredCommand, search: string, searchKeys: readonly string[]): boolean {
  if (!search) {
    return true
  }

  for (const key of searchKeys) {
    if (commandKeyMatchesSearch(command, key, search)) {
      return true
    }
  }

  return false
}

function commandMatchesNamespace(
  command: RegisteredCommand,
  namespace: string | readonly string[] | undefined,
): boolean {
  if (namespace === undefined) {
    return true
  }

  if (!Object.prototype.hasOwnProperty.call(command.fields, "namespace")) {
    return false
  }

  return commandValueMatchesFilter(command.fields.namespace, namespace)
}

function commandMatchesFilters(
  command: RegisteredCommand,
  filters: readonly [string, ActionMapCommandQueryValue][] | undefined,
  options: QueryRegisteredCommandsOptions,
): boolean {
  if (!filters) {
    return true
  }

  for (const [key, matcher] of filters) {
    if (!commandKeyMatchesQuery(command, key, matcher, options)) {
      return false
    }
  }

  return true
}

function commandKeyMatchesSearch(command: RegisteredCommand, key: string, search: string): boolean {
  if (key === "name") {
    if (commandValueMatchesSearch(command.name, search)) {
      return true
    }
  }

  if (Object.prototype.hasOwnProperty.call(command.fields, key)) {
    if (commandValueMatchesSearch(command.fields[key], search)) {
      return true
    }
  }

  if (command.attrs && Object.prototype.hasOwnProperty.call(command.attrs, key)) {
    if (commandValueMatchesSearch(command.attrs[key], search)) {
      return true
    }
  }

  return false
}

function commandKeyMatchesQuery(
  command: RegisteredCommand,
  key: string,
  matcher: ActionMapCommandQueryValue,
  options: QueryRegisteredCommandsOptions,
): boolean {
  if (typeof matcher === "function") {
    let record: ActionMapCommandRecord | undefined
    const getRecord = () => {
      if (!record) {
        record = options.getCommandRecord(command)
      }

      return record
    }
    let foundValue = false

    if (key === "name") {
      foundValue = true
      try {
        if (matcher(command.name, getRecord())) {
          return true
        }
      } catch (error) {
        options.onFilterError(error)
        return false
      }
    }

    if (Object.prototype.hasOwnProperty.call(command.fields, key)) {
      foundValue = true

      try {
        if (matcher(command.fields[key], getRecord())) {
          return true
        }
      } catch (error) {
        options.onFilterError(error)
        return false
      }
    }

    if (command.attrs && Object.prototype.hasOwnProperty.call(command.attrs, key)) {
      foundValue = true

      try {
        if (matcher(command.attrs[key], getRecord())) {
          return true
        }
      } catch (error) {
        options.onFilterError(error)
        return false
      }
    }

    if (!foundValue) {
      try {
        return matcher(undefined, getRecord())
      } catch (error) {
        options.onFilterError(error)
        return false
      }
    }

    return false
  }

  return commandKeyMatchesExact(command, key, matcher)
}

function commandKeyMatchesExact(
  command: RegisteredCommand,
  key: string,
  matcher: unknown | readonly unknown[],
): boolean {
  if (key === "name") {
    if (commandValueMatchesFilter(command.name, matcher)) {
      return true
    }
  }

  if (Object.prototype.hasOwnProperty.call(command.fields, key)) {
    if (commandValueMatchesFilter(command.fields[key], matcher)) {
      return true
    }
  }

  if (command.attrs && Object.prototype.hasOwnProperty.call(command.attrs, key)) {
    if (commandValueMatchesFilter(command.attrs[key], matcher)) {
      return true
    }
  }

  return false
}

function commandValueMatchesFilter(value: unknown, matcher: unknown | readonly unknown[]): boolean {
  if (Array.isArray(matcher)) {
    for (const expected of matcher) {
      if (commandValueMatchesExact(value, expected)) {
        return true
      }
    }

    return false
  }

  return commandValueMatchesExact(value, matcher)
}

function commandValueMatchesExact(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (commandValueMatchesExact(entry, expected)) {
        return true
      }
    }

    return false
  }

  return Object.is(value, expected)
}

function commandValueMatchesSearch(value: unknown, search: string): boolean {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (commandValueMatchesSearch(entry, search)) {
        return true
      }
    }

    return false
  }

  if (typeof value === "string") {
    return value.toLowerCase().includes(search)
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).toLowerCase().includes(search)
  }

  return false
}
