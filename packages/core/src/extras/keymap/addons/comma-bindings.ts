import type { BindingExpander, Keymap } from "../types.js"

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

export function registerCommaBindings(keymap: Keymap): () => void {
  return keymap.appendBindingExpander(commaBindingExpander)
}
