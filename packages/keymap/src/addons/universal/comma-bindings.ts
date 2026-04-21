import type { BindingExpander, Keymap, KeymapEvent } from "../../index.js"

const commaBindingExpander: BindingExpander = ({ input }) => {
  if (!input.includes(",")) {
    return undefined
  }

  const parts = input.split(",").map((part) => part.trim())
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid key sequence "${input}": comma-separated bindings cannot contain empty entries`)
  }

  return parts
}

/**
 * Expands comma-separated binding strings such as `j,k` into separate
 * bindings.
 */
export function registerCommaBindings<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.appendBindingExpander(commaBindingExpander)
}
