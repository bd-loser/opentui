import type { ActionMap } from "../types.js"
import { buildBindingKey, normalizeKeyStroke } from "../lib/utils.js"

function getBaseLayoutKeyName(baseCode: number | undefined): string | undefined {
  if (baseCode === undefined || baseCode < 32 || baseCode === 127) {
    return undefined
  }

  try {
    const name = String.fromCodePoint(baseCode)

    if (name.length === 1 && name >= "A" && name <= "Z") {
      return name.toLowerCase()
    }

    return name
  } catch {
    return undefined
  }
}

export function registerBaseLayoutFallback(manager: ActionMap): () => void {
  return manager.registerEventMatchResolver((event) => {
    const name = getBaseLayoutKeyName(event.baseCode)
    if (!name) {
      return undefined
    }

    return [
      buildBindingKey(
        normalizeKeyStroke({
          name,
          ctrl: event.ctrl,
          shift: event.shift,
          meta: event.meta,
          super: event.super ?? false,
          hyper: event.hyper || undefined,
        }),
      ),
    ]
  })
}
