import type { ActionMap, ReactiveMatcher } from "../types.js"

/**
 * Accepted `enabled` values: boolean, raw `() => boolean`, or an
 * `ReactiveMatcher` for subscription-driven invalidation.
 */
export type Enabled = boolean | (() => boolean) | ReactiveMatcher

function isReactiveMatcher(value: unknown): value is ReactiveMatcher {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as { get?: unknown; subscribe?: unknown }
  return typeof candidate.get === "function" && typeof candidate.subscribe === "function"
}

function normalizeEnabledValue(fieldName: string, value: unknown): Enabled {
  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "function") {
    return value as () => boolean
  }

  if (isReactiveMatcher(value)) {
    return value
  }

  throw new Error(`ActionMap enabled field "${fieldName}" must be a boolean, a function, or a reactive matcher`)
}

export function registerEnabledField(actionMap: ActionMap): () => void {
  return actionMap.registerLayerFields({
    enabled(value, ctx) {
      const normalized = normalizeEnabledValue("enabled", value)
      if (normalized === true) {
        return
      }

      if (normalized === false) {
        ctx.match(() => false)
        return
      }

      ctx.match(normalized)
    },
  })
}
