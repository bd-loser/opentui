import type {
  BindingParser,
  EventMatchResolver,
  KeyMatch,
  Keymap,
  KeymapEvent,
  KeySequencePart,
  KeyStrokeInput,
  ResolvedKeyToken,
} from "../../core.js"

const namedSingleStrokeKeys = new Set<string>([
  "up",
  "down",
  "left",
  "right",
  "escape",
  "return",
  "enter",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "space",
  "lt",
  "gt",
  "plus",
  "minus",
  "equal",
  "comma",
  "period",
  "slash",
  "backslash",
  "semicolon",
  "quote",
  "backquote",
  "leftbracket",
  "rightbracket",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
  "pause",
  "menu",
  "apps",
  "option",
  "alt",
  "meta",
  "super",
  "hyper",
  "control",
  "ctrl",
  "shift",
])

type DefaultParserContext = Parameters<BindingParser>[0]

function parseObjectKeyInput(
  ctx: DefaultParserContext,
  key: KeyStrokeInput,
  display?: string,
  match?: KeyMatch,
): KeySequencePart {
  return ctx.parseObjectKey(key, {
    display,
    match,
  })
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
  normalizeTokenName: (token: string) => string,
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

function parseStringKeyPart(input: string, ctx: DefaultParserContext): KeySequencePart {
  if (input === " ") {
    return ctx.parseObjectKey({ name: "space" }, { display: "space" })
  }

  if (input === "+") {
    return ctx.parseObjectKey({ name: "+" }, { display: "+" })
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

    name = part
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

  return ctx.parseObjectKey(
    {
      name,
      ctrl,
      shift,
      meta,
      super: superKey,
      hyper: hyper || undefined,
    },
    {
      display: displayParts.join("+"),
    },
  )
}

export const defaultBindingParser: BindingParser = (ctx) => {
  const { input, index, tokens, normalizeTokenName } = ctx

  if (index === 0 && isSingleStrokeString(input, tokens, normalizeTokenName)) {
    if (input === " " || input === "+") {
      return {
        parts: [parseStringKeyPart(input, ctx)],
        nextIndex: input.length,
      }
    }

    const normalizedToken = normalizeTokenName(input)
    const token = tokens.get(normalizedToken)
    if (token) {
      return {
        parts: [parseObjectKeyInput(ctx, token.stroke, normalizedToken, token.match)],
        nextIndex: input.length,
        usedTokens: [normalizedToken],
      }
    }

    return {
      parts: [parseStringKeyPart(input, ctx)],
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

    const tokenName = normalizeTokenName(input.slice(index, end + 1))
    const token = tokens.get(tokenName)
    if (!token) {
      return {
        parts: [],
        nextIndex: end + 1,
        unknownTokens: [tokenName],
      }
    }

    return {
      parts: [parseObjectKeyInput(ctx, token.stroke, tokenName, token.match)],
      nextIndex: end + 1,
      usedTokens: [tokenName],
    }
  }

  return {
    parts: [parseStringKeyPart(char, ctx)],
    nextIndex: index + 1,
  }
}

export const defaultEventMatchResolver: EventMatchResolver<KeymapEvent> = (event, ctx) => {
  return [
    ctx.match({
      name: event.name,
      ctrl: event.ctrl,
      shift: event.shift,
      meta: event.meta,
      super: event.super ?? false,
      hyper: event.hyper || undefined,
    }),
  ]
}

export function registerDefaultBindingParser<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.appendBindingParser(defaultBindingParser)
}

export function registerDefaultEventMatchResolver<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.appendEventMatchResolver(defaultEventMatchResolver)
}

export function registerDefaultKeys<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  const offParser = registerDefaultBindingParser(keymap)
  const offResolver = registerDefaultEventMatchResolver(keymap)

  return () => {
    offResolver()
    offParser()
  }
}
