import type { ActionMapBindingParser, ActionMap, ActionMapBindingParserContext, ParsedKeyPart } from "../types.js"

function parseEmacsStroke(
  input: string,
  sequence: string,
  parseObjectKey: ActionMapBindingParserContext["parseObjectKey"],
): ParsedKeyPart {
  const parts = input.split("+")
  let name = ""
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
      throw new Error(`Invalid emacs key sequence "${sequence}": stroke "${input}" contains multiple key names`)
    }

    name = part
  }

  if (!name) {
    throw new Error(`Invalid emacs key sequence "${sequence}": stroke "${input}" is missing a key name`)
  }

  return parseObjectKey({
    name,
    ctrl,
    shift,
    meta,
    super: superKey,
    hyper: hyper || undefined,
  })
}

function parseEmacsSequence(
  input: string,
  parseObjectKey: ActionMapBindingParserContext["parseObjectKey"],
): ParsedKeyPart[] | undefined {
  const strokes = input.trim().split(/\s+/).filter(Boolean)

  if (strokes.length <= 1) {
    return undefined
  }

  if (!strokes.some((stroke) => stroke.includes("+"))) {
    return undefined
  }

  return strokes.map((stroke) => parseEmacsStroke(stroke, input, parseObjectKey))
}

export function registerEmacsBindings(manager: ActionMap): () => void {
  const parseEmacsBinding: ActionMapBindingParser = ({ input, index, parseObjectKey }) => {
    const parsed = parseEmacsSequence(input, parseObjectKey)
    if (!parsed || index !== 0) {
      return undefined
    }

    return {
      parts: parsed,
      nextIndex: input.length,
    }
  }

  return manager.prependBindingParser(parseEmacsBinding)
}
