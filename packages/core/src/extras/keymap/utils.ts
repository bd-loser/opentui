import type { KeyEvent } from "../../lib/KeyHandler.js"
import type {
  KeymapAttributes,
  KeymapBindingCommand,
  KeyStroke,
  KeymapBindingInput,
  KeymapBindings,
  KeymapEventData,
  KeymapStringifiableKey,
  KeymapStringifyOptions,
  ParsedKeyPart,
  ParsedKeyStroke,
  SequenceNode,
} from "./types.js"

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

export function mergeRequirement(target: KeymapEventData, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap requirement for "${name}" from ${source}`)
  }

  target[name] = value
}

export function mergeAttribute(target: KeymapAttributes, name: string, value: unknown, source: string): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && !Object.is(target[name], value)) {
    throw new Error(`Conflicting keymap attribute for "${name}" from ${source}`)
  }

  target[name] = value
}

export function freezeAttributes(attrs: KeymapAttributes): Readonly<KeymapAttributes> | undefined {
  if (Object.keys(attrs).length === 0) {
    return undefined
  }

  return Object.freeze({ ...attrs })
}

export function cloneBindingInput(binding: KeymapBindingInput): KeymapBindingInput {
  return {
    ...binding,
    key: typeof binding.key === "string" ? binding.key : { ...binding.key },
  }
}

export function normalizeBindingCommand(command: KeymapBindingCommand | undefined): KeymapBindingCommand | undefined {
  if (command === undefined || typeof command === "function") {
    return command
  }

  const trimmed = command.trim()
  if (!trimmed) {
    throw new Error("Invalid keymap command: command cannot be empty")
  }

  return trimmed
}

export function snapshotBindingInputs(bindings: KeymapBindings): KeymapBindingInput[] {
  return normalizeBindingInputs(bindings).map((binding) => cloneBindingInput(binding))
}

function hasDisplayStroke(
  input: KeymapStringifiableKey,
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

export function stringifyKeyStroke(input: KeymapStringifiableKey, options?: KeymapStringifyOptions): string {
  if (hasDisplayStroke(input)) {
    if (options?.preferDisplay && input.display) {
      return input.display
    }

    return stringifyCanonicalStroke(input.stroke)
  }

  return stringifyCanonicalStroke(input)
}

export function stringifyKeySequence(
  input: readonly KeymapStringifiableKey[],
  options?: KeymapStringifyOptions,
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
    throw new Error("Invalid keymap command name: name cannot be empty")
  }

  if (/\s/.test(trimmed)) {
    throw new Error(`Invalid keymap command name "${name}": command names cannot contain whitespace`)
  }

  return trimmed
}

export function normalizeBindingInputs(bindings: KeymapBindings): KeymapBindingInput[] {
  if (Array.isArray(bindings)) {
    return bindings
  }

  const normalized: KeymapBindingInput[] = []
  for (const [key, cmd] of Object.entries(bindings)) {
    if (typeof cmd !== "string" && typeof cmd !== "function") {
      throw new Error(`Invalid keymap binding for "${key}": shorthand bindings must map to string or function commands`)
    }

    normalized.push({ key, cmd })
  }

  return normalized
}
