import type { ActionMap, ActionMapReactiveMatcher } from "../types.js"

/**
 * Accepted shapes for the `enabled` layer field:
 *
 * - `boolean` — static on/off. No matcher; static `false` disables the layer.
 * - `() => boolean` — raw callback, re-evaluated on every read. Simple but
 *   not cacheable; use for state the manager has no way to observe.
 * - `ActionMapReactiveMatcher` — a `{ get, subscribe }` pair. The manager
 *   subscribes at layer registration and invalidates the cache on change,
 *   then unsubscribes when the layer is unregistered.
 */
export type ActionMapEnabled = boolean | (() => boolean) | ActionMapReactiveMatcher

function isReactiveMatcher(value: unknown): value is ActionMapReactiveMatcher {
  if (!value || typeof value !== "object") {
    return false
  }

  const candidate = value as { get?: unknown; subscribe?: unknown }
  return typeof candidate.get === "function" && typeof candidate.subscribe === "function"
}

function normalizeEnabledValue(fieldName: string, value: unknown): ActionMapEnabled {
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

export function registerEnabledField(manager: ActionMap): () => void {
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

      // Either a function or a reactive matcher — both are accepted directly
      // by `ctx.match`, which wires subscription for the reactive form.
      ctx.match(normalized)
    },
  })
}
