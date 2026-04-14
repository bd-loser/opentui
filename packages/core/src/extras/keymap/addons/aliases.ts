import { createParsedKeyPart, normalizeKeyName } from "../utils.js"
import type { KeymapManager } from "../types.js"

export type KeymapAliases = Record<string, string>

function normalizeAliases(value: unknown): KeymapAliases {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('Keymap aliases field "aliases" must be an object of key-name mappings')
  }

  const aliases: KeymapAliases = {}

  for (const [name, key] of Object.entries(value as Record<string, unknown>)) {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('Keymap aliases field "aliases" cannot contain empty alias names')
    }

    if (typeof key !== "string") {
      throw new Error(`Keymap alias "${trimmedName}" must map to a string key name`)
    }

    const trimmedKey = key.trim()
    if (!trimmedKey) {
      throw new Error(`Keymap alias "${trimmedName}" cannot map to an empty key name`)
    }

    aliases[trimmedName.toLowerCase()] = trimmedKey.toLowerCase()
  }

  return aliases
}

function getAliases(layer: Readonly<Record<string, unknown>>): KeymapAliases | undefined {
  const aliases = layer.aliases
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    return undefined
  }

  return normalizeAliases(aliases)
}

export function registerAliasesField(manager: KeymapManager): () => void {
  const offLayerField = manager.registerLayerFields({
    aliases(value, ctx) {
      normalizeAliases(value)
    },
  })

  const offBindingParser = manager.registerBindingParser(({ layer, add }) => {
    const aliases = getAliases(layer)
    if (!aliases) {
      return
    }

    for (const name of Object.keys(aliases)) {
      add(name)
    }
  })

  const offBindingCompiler = manager.registerBindingCompiler((binding, ctx) => {
    const aliases = getAliases(ctx.layer)
    if (!aliases) {
      return
    }

    if (binding.sequence.length !== 1) {
      return
    }

    const [part] = binding.sequence
    if (!part) {
      return
    }

    const aliasedName = aliases[part.stroke.name]
    if (!aliasedName) {
      return
    }

    ctx.add({
      ...binding,
      sequence: [
        createParsedKeyPart({
          ...part.stroke,
          name: normalizeKeyName(aliasedName),
        }),
      ],
    })
  })

  return () => {
    offBindingParser()
    offBindingCompiler()
    offLayerField()
  }
}
