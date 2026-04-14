import type { KeyEvent } from "../../lib/KeyHandler.js"
import type {
  KeymapAttributes,
  KeymapBindingCommand,
  KeyLike,
  KeyStroke,
  KeymapBindingInput,
  KeymapBindings,
  KeymapEventData,
  KeymapParsedCommand,
  KeymapStringifiableKey,
  KeymapStringifyOptions,
  ParsedKeyPart,
  ParsedKeyStroke,
  RegisteredLayer,
  SequenceNode,
} from "./types.js"

const namedSingleStrokeKeys = new Set<string>([
  "space",
  "tab",
  "linefeed",
  "return",
  "escape",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "left",
  "right",
  "up",
  "down",
  "kp0",
  "kp1",
  "kp2",
  "kp3",
  "kp4",
  "kp5",
  "kp6",
  "kp7",
  "kp8",
  "kp9",
  "kpdecimal",
  "kpdivide",
  "kpmultiply",
  "kpminus",
  "kpplus",
  "kpenter",
  "kpequal",
  "kpseparator",
  "kpleft",
  "kpright",
  "kpup",
  "kpdown",
  "kppageup",
  "kppagedown",
  "kphome",
  "kpend",
  "kpinsert",
  "kpdelete",
  "clear",
])

for (let index = 1; index <= 24; index += 1) {
  namedSingleStrokeKeys.add(`f${index}`)
}

const emptyTokens = new Map<string, ParsedKeyStroke>()

export function normalizeTokenName(token: string): string {
  return token.trim().toLowerCase()
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

export function sortByPriorityAndOrder<T extends { priority: number; order: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const priorityDiff = b.priority - a.priority
    if (priorityDiff !== 0) {
      return priorityDiff
    }

    return a.order - b.order
  })
}

export function sortLayersWithinScope(items: RegisteredLayer[]): RegisteredLayer[] {
  return [...items].sort((a, b) => {
    const priorityDiff = b.priority - a.priority
    if (priorityDiff !== 0) {
      return priorityDiff
    }

    return b.order - a.order
  })
}

export function buildBindingKey(stroke: ParsedKeyStroke): string {
  return `${stroke.name}:${stroke.ctrl ? 1 : 0}:${stroke.shift ? 1 : 0}:${stroke.meta ? 1 : 0}:${stroke.super ? 1 : 0}:${stroke.hyper ? 1 : 0}`
}

export function createSequenceNode(parent: SequenceNode | null, stroke: ParsedKeyStroke | null): SequenceNode {
  return {
    parent,
    depth: parent ? parent.depth + 1 : 0,
    stroke,
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

export function bindingUsesTokenSyntax(binding: KeymapBindingInput): boolean {
  return typeof binding.key === "string" && binding.key.includes("<")
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
): ParsedKeyPart {
  return {
    stroke: cloneStroke(stroke),
    display,
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

function isNamedSingleStrokeKey(input: string, extraNames?: ReadonlySet<string>): boolean {
  const normalized = input.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  if (namedSingleStrokeKeys.has(normalized)) {
    return true
  }

  if (extraNames?.has(normalized)) {
    return true
  }

  return /^f\d{1,2}$/i.test(normalized)
}

function isSingleStrokeString(
  input: string,
  tokens: ReadonlyMap<string, ParsedKeyStroke>,
  extraNames?: ReadonlySet<string>,
): boolean {
  if (input === " " || input === "+") {
    return true
  }

  if (input.length === 1) {
    return true
  }

  if (tokens.has(normalizeTokenName(input))) {
    return true
  }

  if (input.includes("+")) {
    return true
  }

  return isNamedSingleStrokeKey(input, extraNames)
}

function parseStringKeyPart(input: string): ParsedKeyPart {
  if (input === " ") {
    return createParsedKeyPart({ name: "space", ctrl: false, shift: false, meta: false, super: false }, "space")
  }

  if (input === "+") {
    return createParsedKeyPart({ name: "+", ctrl: false, shift: false, meta: false, super: false }, "+")
  }

  const parts = input.split("+")
  let name = ""
  let displayName = ""
  let ctrl = false
  let shift = false
  let meta = false
  let superKey = false
  let hyper = false

  for (const rawPart of parts) {
    const part = rawPart.trim()
    if (!part) {
      continue
    }

    const lowered = part.toLowerCase()
    if (lowered === "ctrl" || lowered === "control") {
      ctrl = true
      continue
    }

    if (lowered === "shift") {
      shift = true
      continue
    }

    if (lowered === "meta" || lowered === "alt" || lowered === "option") {
      meta = true
      continue
    }

    if (lowered === "super") {
      superKey = true
      continue
    }

    if (lowered === "hyper") {
      hyper = true
      continue
    }

    if (name) {
      throw new Error(`Invalid key "${input}": multiple key names are not supported`)
    }

    name = normalizeKeyName(part)
    displayName = lowered
  }

  if (!name) {
    throw new Error(`Invalid key "${input}": missing key name`)
  }

  const displayParts: string[] = []
  if (ctrl) {
    displayParts.push("ctrl")
  }

  if (shift) {
    displayParts.push("shift")
  }

  if (meta) {
    displayParts.push("meta")
  }

  if (superKey) {
    displayParts.push("super")
  }

  if (hyper) {
    displayParts.push("hyper")
  }

  displayParts.push(displayName)

  return createParsedKeyPart(
    {
      name,
      ctrl,
      shift,
      meta,
      super: superKey,
      hyper: hyper || undefined,
    },
    displayParts.join("+"),
  )
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

function parseStringSequence(
  input: string,
  tokens: ReadonlyMap<string, ParsedKeyStroke>,
): ParsedKeyPart[] {
  const parts: ParsedKeyPart[] = []
  let index = 0

  while (index < input.length) {
    const char = input[index]
    if (char === "<") {
      const end = input.indexOf(">", index)
      if (end === -1) {
        throw new Error(`Invalid key sequence "${input}": unterminated token`)
      }

      const tokenName = normalizeTokenName(input.slice(index, end + 1))
      const token = tokens.get(tokenName)
      if (!token) {
        index = end + 1
        continue
      }

      parts.push(createParsedKeyPart(token, tokenName))
      index = end + 1
      continue
    }

    parts.push(parseStringKeyPart(char))
    index += 1
  }
  return parts
}

export function parseKeyLike(key: KeyLike, extraNames?: ReadonlySet<string>): ParsedKeyStroke {
  if (typeof key === "string" && !isSingleStrokeString(key, emptyTokens, extraNames)) {
    throw new Error(`Invalid key "${key}": expected a single key stroke`)
  }

  const [part] = parseKeySequenceLike(key, emptyTokens, extraNames)
  if (!part) {
    throw new Error(`Invalid key "${String(key)}": expected a single key stroke`)
  }

  return cloneStroke(part.stroke)
}

export function parseKeySequenceLike(
  key: KeyLike,
  tokens: ReadonlyMap<string, ParsedKeyStroke> = emptyTokens,
  extraNames?: ReadonlySet<string>,
): ParsedKeyPart[] {
  if (typeof key !== "string") {
    return [createParsedKeyPart(normalizeKeyStroke(key))]
  }

  if (key.length === 0) {
    throw new Error("Invalid key sequence: sequence cannot be empty")
  }

  if (isSingleStrokeString(key, tokens, extraNames)) {
    const normalizedToken = normalizeTokenName(key)
    const token = tokens.get(normalizedToken)
    if (token) {
      return [createParsedKeyPart(token, normalizedToken)]
    }

    return [parseStringKeyPart(key)]
  }

  return parseStringSequence(key, tokens)
}

export function parseCommandInput(input: string): KeymapParsedCommand {
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
