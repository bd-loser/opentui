import type { KeyEvent } from "../../lib/KeyHandler.js"
import { defaultKeyAliases } from "../../lib/keymapping.js"
import type {
  KeyLike,
  KeyStroke,
  KeymapBindingInput,
  KeymapBindings,
  KeymapResolvedCommand,
  KeymapStringifiableKey,
  KeymapStringifyOptions,
  ParsedKeyPart,
  ParsedKeyStroke,
} from "./core.js"

const namedSingleStrokeKeys = new Set<string>([
  "space",
  "tab",
  "return",
  "enter",
  "escape",
  "esc",
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
  ...Object.keys(defaultKeyAliases),
  ...Object.values(defaultKeyAliases),
])

for (let index = 1; index <= 24; index += 1) {
  namedSingleStrokeKeys.add(`f${index}`)
}

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

  const seen = new Set<string>()
  while (defaultKeyAliases[next] && !seen.has(next)) {
    seen.add(next)
    next = defaultKeyAliases[next]!
  }

  return next
}

export function cloneStroke(stroke: ParsedKeyStroke): ParsedKeyStroke {
  return {
    name: stroke.name,
    ctrl: stroke.ctrl,
    shift: stroke.shift,
    meta: stroke.meta,
    super: stroke.super,
  }
}

export function clonePart(part: ParsedKeyPart): ParsedKeyPart {
  return {
    stroke: cloneStroke(part.stroke),
    display: part.display,
  }
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

function isNamedSingleStrokeKey(input: string): boolean {
  const normalized = input.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  if (namedSingleStrokeKeys.has(normalized)) {
    return true
  }

  return /^f\d{1,2}$/i.test(normalized)
}

function isSingleStrokeString(input: string, tokens: ReadonlyMap<string, { stroke: ParsedKeyStroke }>): boolean {
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

  return isNamedSingleStrokeKey(input)
}

function parseKeyChord(input: string): ParsedKeyStroke {
  if (input === " ") {
    return { name: "space", ctrl: false, shift: false, meta: false, super: false }
  }

  if (input === "+") {
    return { name: "+", ctrl: false, shift: false, meta: false, super: false }
  }

  const parts = input.split("+")
  let name = ""
  let ctrl = false
  let shift = false
  let meta = false
  let superKey = false

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

    if (name) {
      throw new Error(`Invalid key "${input}": multiple key names are not supported`)
    }

    name = normalizeKeyName(part)
  }

  if (!name) {
    throw new Error(`Invalid key "${input}": missing key name`)
  }

  return {
    name,
    ctrl,
    shift,
    meta,
    super: superKey,
  }
}

function normalizeKeyDisplayInput(input: string): string {
  if (input === " ") {
    return "space"
  }

  if (input === "+") {
    return "+"
  }

  const parts = input.split("+")
  let name = ""
  let ctrl = false
  let shift = false
  let meta = false
  let superKey = false

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

    if (name) {
      throw new Error(`Invalid key "${input}": multiple key names are not supported`)
    }

    name = lowered
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

  displayParts.push(name)
  return displayParts.join("+")
}

function normalizeKeyStroke(input: KeyStroke): ParsedKeyStroke {
  return {
    name: normalizeKeyName(input.name),
    ctrl: input.ctrl ?? false,
    shift: input.shift ?? false,
    meta: input.meta ?? false,
    super: input.super ?? false,
  }
}

export function normalizeEventKeyStroke(event: KeyEvent): ParsedKeyStroke {
  return {
    name: normalizeKeyName(event.name),
    ctrl: event.ctrl,
    shift: event.shift,
    meta: event.meta,
    super: event.super ?? false,
  }
}

function parseStringSequence(input: string, tokens: ReadonlyMap<string, { stroke: ParsedKeyStroke }>): ParsedKeyPart[] {
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
        throw new Error(`Unknown keymap token "${tokenName}"`)
      }

      parts.push(createParsedKeyPart(token.stroke, tokenName))
      index = end + 1
      continue
    }

    parts.push(createParsedKeyPart(parseKeyChord(char), normalizeKeyDisplayInput(char)))
    index += 1
  }

  if (parts.length === 0) {
    throw new Error(`Invalid key sequence "${input}": sequence cannot be empty`)
  }

  return parts
}

export function parseKeyLike(key: KeyLike): ParsedKeyStroke {
  if (typeof key !== "string") {
    return normalizeKeyStroke(key)
  }

  if (!isSingleStrokeString(key, new Map())) {
    throw new Error(`Invalid key "${key}": expected a single key stroke`)
  }

  return parseKeyChord(key)
}

export function parseKeySequenceLike(
  key: KeyLike,
  tokens: ReadonlyMap<string, { stroke: ParsedKeyStroke }>,
): ParsedKeyPart[] {
  if (typeof key !== "string") {
    return [createParsedKeyPart(normalizeKeyStroke(key))]
  }

  if (key.length === 0) {
    throw new Error("Invalid key sequence: sequence cannot be empty")
  }

  if (isSingleStrokeString(key, tokens)) {
    const normalizedToken = normalizeTokenName(key)
    const token = tokens.get(normalizedToken)
    if (token) {
      return [createParsedKeyPart(token.stroke, normalizedToken)]
    }

    return [createParsedKeyPart(parseKeyChord(key), normalizeKeyDisplayInput(key))]
  }

  return parseStringSequence(key, tokens)
}

export function parseCommandInput(input: string): KeymapResolvedCommand {
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
    if (typeof cmd !== "string") {
      throw new Error(`Invalid keymap binding for "${key}": shorthand bindings must map to string commands`)
    }

    normalized.push({ key, cmd })
  }

  return normalized
}
