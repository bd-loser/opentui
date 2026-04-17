import type { KeyEvent } from "../../lib/KeyHandler.js"
import type {
  ActionMapAttributes,
  ActionMapBindingCommand,
  KeyStroke,
  ActionMapBindingInput,
  ActionMapBindings,
  ActionMapEventData,
  ActionMapStringifiableKey,
  ActionMapStringifyOptions,
  ParsedKeyPart,
  ParsedKeyStroke,
  SequenceNode,
} from "./types.js"

export interface CloneDataValueOptions {
  deep?: boolean
  freeze?: boolean
  preserveNonPlainObjects?: boolean
}

export function normalizeKeyName(name: string): string {
  if (name === " ") {
    return "space"
  }

  let next = name.trim()
  if (!next) {
    throw new Error("Invalid key name: key name cannot be empty")
  }

  next = next.toLowerCase()

  return next
}

export function cloneStroke(stroke: ParsedKeyStroke): ParsedKeyStroke {
  return {
    name: stroke.name,
    ctrl: stroke.ctrl,
    shift: stroke.shift,
    meta: stroke.meta,
    super: stroke.super,
    hyper: stroke.hyper || undefined,
  }
}

export function isPromiseLike(value: unknown): value is Promise<unknown> {
  if (!value) {
    return false
  }

  if (typeof value !== "object" && typeof value !== "function") {
    return false
  }

  return typeof (value as { then?: unknown }).then === "function"
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// This is intentionally narrower than `structuredClone(...)`: some action-map
// metadata needs to preserve opaque values such as functions or class instances.
export function cloneDataValue(value: unknown, options?: CloneDataValueOptions): unknown {
  const deep = options?.deep === true
  const freeze = options?.freeze === true
  const preserveNonPlainObjects = options?.preserveNonPlainObjects === true

  if (Array.isArray(value)) {
    const cloned = deep ? value.map((entry) => cloneDataValue(entry, options)) : [...value]
    return freeze ? Object.freeze(cloned) : cloned
  }

  if (value && typeof value === "object") {
    if (preserveNonPlainObjects && !isPlainObject(value)) {
      return value
    }

    const cloned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      cloned[key] = deep ? cloneDataValue(entry, options) : entry
    }

    return freeze ? Object.freeze(cloned) : cloned
  }

  return value
}

export function sortByPriorityAndOrder<T extends { priority: number; order: number }>(
  items: T[],
  options?: { order?: "asc" | "desc" },
): T[] {
  const orderDirection = options?.order ?? "asc"

  return [...items].sort((a, b) => {
    const priorityDiff = b.priority - a.priority
    if (priorityDiff !== 0) {
      return priorityDiff
    }

    return orderDirection === "desc" ? b.order - a.order : a.order - b.order
  })
}

export function buildBindingKey(stroke: ParsedKeyStroke): string {
  return `${stroke.name}:${stroke.ctrl ? 1 : 0}:${stroke.shift ? 1 : 0}:${stroke.meta ? 1 : 0}:${stroke.super ? 1 : 0}:${stroke.hyper ? 1 : 0}`
}

export function createSequenceNode(
  parent: SequenceNode | null,
  stroke: ParsedKeyStroke | null,
  matchKey: string | null,
): SequenceNode {
  return {
    parent,
    depth: parent ? parent.depth + 1 : 0,
    stroke,
    matchKey,
    children: new Map(),
    bindings: [],
    reachableBindings: [],
  }
}

export function mergeRequirement(target: ActionMapEventData, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting action map requirement for "${name}" from ${source}`)
  }

  target[name] = value
}

export function mergeAttribute(target: ActionMapAttributes, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting action map attribute for "${name}" from ${source}`)
  }

  target[name] = value
}

export function freezeAttributes(attrs: ActionMapAttributes): Readonly<ActionMapAttributes> | undefined {
  if (Object.keys(attrs).length === 0) {
    return undefined
  }

  return cloneDataValue(attrs, { freeze: true }) as Readonly<ActionMapAttributes>
}

export function cloneBindingInput(binding: ActionMapBindingInput): ActionMapBindingInput {
  return {
    ...binding,
    key: typeof binding.key === "string" ? binding.key : { ...binding.key },
  }
}

export function normalizeBindingCommand(
  command: ActionMapBindingCommand | undefined,
): ActionMapBindingCommand | undefined {
  if (command === undefined || typeof command === "function") {
    return command
  }

  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error("Invalid action map command: command cannot be empty")
  }

  return trimmed
}

export function snapshotBindingInputs(bindings: ActionMapBindings): ActionMapBindingInput[] {
  return normalizeBindingInputs(bindings).map((binding) => cloneBindingInput(binding))
}

function hasDisplayStroke(
  input: ActionMapStringifiableKey,
): input is ParsedKeyPart | { stroke: ParsedKeyStroke; display?: string } {
  return "stroke" in input
}

function stringifyCanonicalStroke(stroke: ParsedKeyStroke): string {
  const parts: string[] = []
  if (stroke.ctrl) {
    parts.push("ctrl")
  }

  if (stroke.shift) {
    parts.push("shift")
  }

  if (stroke.meta) {
    parts.push("meta")
  }

  if (stroke.super) {
    parts.push("super")
  }

  if (stroke.hyper) {
    parts.push("hyper")
  }

  parts.push(stroke.name === "return" ? "enter" : stroke.name)
  return parts.join("+")
}

export function createParsedKeyPart(
  stroke: ParsedKeyStroke,
  display = stringifyCanonicalStroke(stroke),
  matchKey?: string,
): ParsedKeyPart {
  const cloned = cloneStroke(stroke)

  return {
    stroke: cloned,
    display,
    matchKey: matchKey ?? buildBindingKey(cloned),
  }
}

export function stringifyKeyStroke(input: ActionMapStringifiableKey, options?: ActionMapStringifyOptions): string {
  if (hasDisplayStroke(input)) {
    if (options?.preferDisplay && input.display) {
      return input.display
    }

    return stringifyCanonicalStroke(input.stroke)
  }

  return stringifyCanonicalStroke(input)
}

export function stringifyKeySequence(
  input: readonly ActionMapStringifiableKey[],
  options?: ActionMapStringifyOptions,
): string {
  return input.map((part) => stringifyKeyStroke(part, options)).join("")
}

export function normalizeKeyStroke(input: KeyStroke): ParsedKeyStroke {
  return {
    name: normalizeKeyName(input.name),
    ctrl: input.ctrl ?? false,
    shift: input.shift ?? false,
    meta: input.meta ?? false,
    super: input.super ?? false,
    hyper: input.hyper || undefined,
  }
}

export function normalizeEventKeyStroke(event: KeyEvent): ParsedKeyStroke {
  return {
    name: normalizeKeyName(event.name),
    ctrl: event.ctrl,
    shift: event.shift,
    meta: event.meta,
    super: event.super ?? false,
    hyper: event.hyper || undefined,
  }
}

export function normalizeCommandName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error("Invalid action map command name: name cannot be empty")
  }

  if (/\s/.test(trimmed)) {
    throw new Error(`Invalid action map command name "${name}": command names cannot contain whitespace`)
  }

  return trimmed
}

export function normalizeBindingInputs(bindings: ActionMapBindings): ActionMapBindingInput[] {
  if (Array.isArray(bindings)) {
    return bindings
  }

  const normalized: ActionMapBindingInput[] = []
  for (const [key, cmd] of Object.entries(bindings)) {
    if (typeof cmd !== "string" && typeof cmd !== "function") {
      throw new Error(
        `Invalid action map binding for "${key}": shorthand bindings must map to string or function commands`,
      )
    }

    normalized.push({ key, cmd })
  }

  return normalized
}
