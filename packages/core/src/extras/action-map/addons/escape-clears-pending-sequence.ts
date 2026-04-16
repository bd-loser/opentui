import type { ActionMap } from "../types.js"

export interface EscapeClearsPendingSequenceOptions {
  consume?: boolean
  priority?: number
}

export function registerEscapeClearsPendingSequence(
  manager: ActionMap,
  options?: EscapeClearsPendingSequenceOptions,
): () => void {
  const shouldConsume = options?.consume ?? true

  return manager.onKeyInput(
    ({ event, consume }) => {
      if (event.name !== "escape") {
        return
      }

      if (!manager.hasPendingSequence()) {
        return
      }

      manager.clearPendingSequence()

      if (shouldConsume) {
        consume()
      }
    },
    { priority: options?.priority ?? 0 },
  )
}
