import type { KeymapBindingParser, KeymapManager, ParsedKeyPart } from "../types.js"
import { createParsedKeyPart, normalizeKeyName } from "../utils.js"

function parseEmacsStroke(input: string, sequence: string): ParsedKeyPart {
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
      throw new Error(`Invalid emacs key sequence "${sequence}": stroke "${input}" contains multiple key names`)
    }

    name = normalizeKeyName(part)
    displayName = lowered
  }

  if (!name) {
    throw new Error(`Invalid emacs key sequence "${sequence}": stroke "${input}" is missing a key name`)
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

function parseEmacsSequence(input: string): ParsedKeyPart[] | undefined {
  const strokes = input
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (strokes.length <= 1) {
    return undefined
  }

  if (!strokes.some((stroke) => stroke.includes("+"))) {
    return undefined
  }

  return strokes.map((stroke) => parseEmacsStroke(stroke, input))
}

export function registerEmacsBindings(manager: KeymapManager): () => void {
  const parseEmacsBinding: KeymapBindingParser = ({ input, index }) => {
    const parsed = parseEmacsSequence(input)
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
