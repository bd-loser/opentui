import type { KeymapManager } from "../types.js"

export interface KeymapKeyedEnabled {
  match: () => boolean
  keys: readonly string[]
}

export type KeymapEnabled = boolean | (() => boolean) | KeymapKeyedEnabled

function isKeyedEnabledValue(value: unknown): value is KeymapKeyedEnabled {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as { match?: unknown; keys?: unknown }
  if (typeof candidate.match !== "function") {
    return false
  }

  return Array.isArray(candidate.keys)
}

function normalizeEnabledValue(fieldName: string, value: unknown): KeymapEnabled {
  if (typeof value === "boolean" || typeof value === "function" || isKeyedEnabledValue(value)) {
    return value
  }

  throw new Error(`Keymap enabled field "${fieldName}" must be a boolean, function, or { match, keys } object`)
}

function resolveEnabledValue(value: boolean | (() => boolean)): boolean {
  if (typeof value !== "function") {
    return value
  }

  return value()
}

export function registerEnabledField(manager: KeymapManager): () => void {
  return manager.registerLayerFields({
    enabled(value, ctx) {
      const normalized = normalizeEnabledValue("enabled", value)
      if (normalized === true) {
        return
      }

      if (normalized === false) {
        ctx.match(() => false)
        return
      }

      if (typeof normalized === "function") {
        ctx.match(() => resolveEnabledValue(normalized))
        return
      }

      ctx.match(() => resolveEnabledValue(normalized.match), { keys: normalized.keys })
    },
  })
}
