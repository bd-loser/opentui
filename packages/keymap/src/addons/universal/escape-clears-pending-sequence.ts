import type { Keymap, KeymapEvent } from "../../core.js"

export interface EscapeClearsPendingSequenceOptions {
  /**
   * When true, consume Escape after clearing the sequence so it does not
   * reach the focused renderable or lower-priority listeners. Default: `true`.
   */
  preventDefault?: boolean
  priority?: number
}

export function registerEscapeClearsPendingSequence<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  options?: EscapeClearsPendingSequenceOptions,
): () => void {
  const shouldPreventDefault = options?.preventDefault ?? true

  return keymap.intercept(
    "key",
    ({ event, consume }) => {
      if (event.name !== "escape") {
        return
      }

      if (!keymap.hasPendingSequence()) {
        return
      }

      keymap.clearPendingSequence()

      if (shouldPreventDefault) {
        consume()
      }
    },
    { priority: options?.priority ?? 0 },
  )
}
