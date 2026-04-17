import type { ActionMap } from "../types.js"

export interface EscapeClearsPendingSequenceOptions {
  /**
   * When true, consume Escape after clearing the sequence so it does not
   * reach the focused renderable or lower-priority listeners. Default: `true`.
   */
  preventDefault?: boolean
  priority?: number
}

export function registerEscapeClearsPendingSequence(
  actionMap: ActionMap,
  options?: EscapeClearsPendingSequenceOptions,
): () => void {
  const shouldPreventDefault = options?.preventDefault ?? true

  return actionMap.onKeyInput(
    ({ event, consume }) => {
      if (event.name !== "escape") {
        return
      }

      if (!actionMap.hasPendingSequence()) {
        return
      }

      actionMap.clearPendingSequence()

      if (shouldPreventDefault) {
        consume()
      }
    },
    { priority: options?.priority ?? 0 },
  )
}
