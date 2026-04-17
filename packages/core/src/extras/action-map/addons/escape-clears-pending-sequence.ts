import type { ActionMap } from "../types.js"

export interface EscapeClearsPendingSequenceOptions {
  /**
   * When Escape clears a pending multi-key sequence, also call
   * `event.preventDefault()` + `event.stopPropagation()` so the keystroke is
   * hidden from the focused renderable and lower-priority key-input
   * listeners. Default: `true`.
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
