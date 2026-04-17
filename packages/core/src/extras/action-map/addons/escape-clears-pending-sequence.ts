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
  manager: ActionMap,
  options?: EscapeClearsPendingSequenceOptions,
): () => void {
  const shouldPreventDefault = options?.preventDefault ?? true

  return manager.onKeyInput(
    ({ event, consume }) => {
      if (event.name !== "escape") {
        return
      }

      if (!manager.hasPendingSequence()) {
        return
      }

      manager.clearPendingSequence()

      if (shouldPreventDefault) {
        consume()
      }
    },
    { priority: options?.priority ?? 0 },
  )
}
