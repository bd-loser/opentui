import type { ActionMap } from "../types.js"

export interface BackspacePopsPendingSequenceOptions {
  /**
   * When true, consume Backspace after popping the sequence so it does not
   * reach the focused renderable or lower-priority listeners. Default: `true`.
   */
  preventDefault?: boolean
  priority?: number
}

export function registerBackspacePopsPendingSequence(
  actionMap: ActionMap,
  options?: BackspacePopsPendingSequenceOptions,
): () => void {
  const shouldPreventDefault = options?.preventDefault ?? true

  return actionMap.intercept(
    "key",
    ({ event, consume }) => {
      if (event.name !== "backspace") {
        return
      }

      if (!actionMap.popPendingSequence()) {
        return
      }

      if (shouldPreventDefault) {
        consume()
      }
    },
    { priority: options?.priority ?? 0 },
  )
}
