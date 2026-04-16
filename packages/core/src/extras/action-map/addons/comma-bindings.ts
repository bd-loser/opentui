import type { ActionMapBindingExpander, ActionMap } from "../types.js"

const commaBindingExpander: ActionMapBindingExpander = ({ input }) => {
  if (!input.includes(",")) {
    return undefined
  }

  const parts = input.split(",").map((part) => part.trim())
  if (parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid key sequence "${input}": comma-separated bindings cannot contain empty entries`)
  }

  return parts
}

export function registerCommaBindings(manager: ActionMap): () => void {
  return manager.appendBindingExpander(commaBindingExpander)
}
