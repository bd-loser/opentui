import type { KeymapManager } from "../types.js"

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

export function registerBaseLayoutFallback(manager: KeymapManager): () => void {
  return manager.registerStrokeFallbackResolver((event, stroke) => {
    const name = getBaseLayoutKeyName(event.baseCode)
    if (!name || name === stroke.name) {
      return undefined
    }

    return {
      name,
      ctrl: stroke.ctrl,
      shift: stroke.shift,
      meta: stroke.meta,
      super: stroke.super,
      hyper: stroke.hyper,
    }
  })
}
