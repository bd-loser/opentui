import type { ActionMap } from "../types.js"

export type ActionMapAliases = Record<string, string>

function normalizeAliases(value: unknown): ActionMapAliases {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error('ActionMap aliases field "aliases" must be an object of key-name mappings')
  }

  const aliases: ActionMapAliases = {}

  for (const [name, key] of Object.entries(value as Record<string, unknown>)) {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new Error('ActionMap aliases field "aliases" cannot contain empty alias names')
    }

    if (typeof key !== "string") {
      throw new Error(`ActionMap alias "${trimmedName}" must map to a string key name`)
    }

    const trimmedKey = key.trim()
    if (!trimmedKey) {
      throw new Error(`ActionMap alias "${trimmedName}" cannot map to an empty key name`)
    }

    aliases[trimmedName.toLowerCase()] = trimmedKey.toLowerCase()
  }

  return aliases
}

function getAliases(layer: Readonly<Record<string, unknown>>): ActionMapAliases | undefined {
  const aliases = layer.aliases
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    return undefined
  }

  return normalizeAliases(aliases)
}

export function registerAliasesField(manager: ActionMap): () => void {
  const offLayerField = manager.registerLayerFields({
    aliases(value, ctx) {
      normalizeAliases(value)
    },
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
        ctx.parseKey({
          ...part.stroke,
          name: aliasedName,
        }),
      ],
    })
  })

  return () => {
    offBindingCompiler()
    offLayerField()
  }
}
