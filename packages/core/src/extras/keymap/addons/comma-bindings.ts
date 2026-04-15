import type { KeymapBindingExpander, KeymapManager } from "../types.js"

const commaBindingExpander: KeymapBindingExpander = ({ input }) => {
  if (!input.includes(",")) {
    return undefined
  }

  const parts = input.split(",").map((part) => part.trim())
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid key sequence "${input}": comma-separated bindings cannot contain empty entries`)
  }

  return parts
}

export function registerCommaBindings(manager: KeymapManager): () => void {
  return manager.appendBindingExpander(commaBindingExpander)
}
