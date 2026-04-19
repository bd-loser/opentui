import type {
  BindingParser,
  BindingSyntax,
  EventMatchResolver,
  KeyLike,
  KeyStrokeInput,
  KeySequencePart,
  ResolvedKeyToken,
  NormalizedKeyStroke,
} from "../types.js"
import {
  buildBindingKey,
  createParsedKeyPart,
  normalizeEventKeyStroke,
  normalizeKeyName,
  normalizeKeyStroke,
  snapshotStroke,
} from "./utils.js"
import { namedSingleStrokeKeys } from "./named-keys.js"

const emptyTokens = new Map<string, ResolvedKeyToken>()

export const defaultBindingSyntax: BindingSyntax = {
  normalizeTokenName(token) {
    const normalized = token.trim().toLowerCase()
    if (!normalized) {
      throw new Error("Invalid keymap token: token cannot be empty")
    }

    return normalized
  },
  parseObjectKey(key: KeyStrokeInput) {
    return createParsedKeyPart(normalizeKeyStroke(key))
  },
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
  tokens: ReadonlyMap<string, ResolvedKeyToken>,
  extraNames?: ReadonlySet<string>,
): boolean {
  if (input === " " || input === "+") {
    return true
  }

  if (input.length === 1) {
    return true
  }

  if (tokens.has(input.trim().toLowerCase())) {
    return true
  }

  if (input.includes("+")) {
    return true
  }

  return isNamedSingleStrokeKey(input, extraNames)
}

function parseStringKeyPart(input: string): KeySequencePart {
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
  if (ctrl) displayParts.push("ctrl")
  if (shift) displayParts.push("shift")
  if (meta) displayParts.push("meta")
  if (superKey) displayParts.push("super")
  if (hyper) displayParts.push("hyper")
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

function parseKeySequenceWithDefaultParser(
  key: KeyLike,
  tokens: ReadonlyMap<string, ResolvedKeyToken> = emptyTokens,
  extraNames?: ReadonlySet<string>,
): KeySequencePart[] {
  if (typeof key !== "string") {
    return [defaultBindingSyntax.parseObjectKey(key)]
  }

  if (key.length === 0) {
    throw new Error("Invalid key sequence: sequence cannot be empty")
  }

  if (isSingleStrokeString(key, tokens, extraNames)) {
    const normalizedToken = key.trim().toLowerCase()
    const token = tokens.get(normalizedToken)
    if (token) {
      return [createParsedKeyPart(token.stroke, normalizedToken, token.matchKey)]
    }

    return [parseStringKeyPart(key)]
  }

  const parts: KeySequencePart[] = []
  let index = 0

  while (index < key.length) {
    const result = defaultBindingParser({
      input: key,
      index,
      layer: Object.freeze({}),
      tokens,
      parseObjectKey: defaultBindingSyntax.parseObjectKey,
    })
    if (!result || result.nextIndex <= index) {
      throw new Error(`Default keymap binding parser must advance the input for "${key}" at index ${index}`)
    }

    parts.push(...result.parts)
    index = result.nextIndex
  }

  return parts
}

export const defaultBindingParser: BindingParser = ({ input, index, tokens }) => {
  if (index === 0 && isSingleStrokeString(input, tokens)) {
    const normalizedToken = input.trim().toLowerCase()
    const token = tokens.get(normalizedToken)
    if (token) {
      return {
        parts: [createParsedKeyPart(token.stroke, normalizedToken, token.matchKey)],
        nextIndex: input.length,
        usedTokens: [normalizedToken],
      }
    }

    return {
      parts: [parseStringKeyPart(input)],
      nextIndex: input.length,
    }
  }

  const char = input[index]
  if (char === undefined) {
    return undefined
  }

  if (char === "<") {
    const end = input.indexOf(">", index)
    if (end === -1) {
      throw new Error(`Invalid key sequence "${input}": unterminated token`)
    }

    const tokenName = input
      .slice(index, end + 1)
      .trim()
      .toLowerCase()
    const token = tokens.get(tokenName)
    if (!token) {
      return {
        parts: [],
        nextIndex: end + 1,
        unknownTokens: [tokenName],
      }
    }

    return {
      parts: [createParsedKeyPart(token.stroke, tokenName, token.matchKey)],
      nextIndex: end + 1,
      usedTokens: [tokenName],
    }
  }

  return {
    parts: [parseStringKeyPart(char)],
    nextIndex: index + 1,
  }
}

export function parseKeyLike(key: KeyLike, extraNames?: ReadonlySet<string>): NormalizedKeyStroke {
  const parts = parseKeySequenceWithDefaultParser(key, emptyTokens, extraNames)
  const [part] = parts
  if (!part) {
    throw new Error(`Invalid key "${String(key)}": expected a single key stroke`)
  }

  if (parts.length !== 1) {
    throw new Error(`Invalid key "${key}": expected a single key stroke`)
  }

  return snapshotStroke(part.stroke)
}

export function parseKeySequenceLike(
  key: KeyLike,
  tokens: ReadonlyMap<string, ResolvedKeyToken> = emptyTokens,
  extraNames?: ReadonlySet<string>,
): KeySequencePart[] {
  return parseKeySequenceWithDefaultParser(key, tokens, extraNames)
}

export const defaultEventMatchResolver: EventMatchResolver = (event) => {
  return [buildBindingKey(normalizeEventKeyStroke(event))]
}
