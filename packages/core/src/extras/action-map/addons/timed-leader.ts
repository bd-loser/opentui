import type { ActionMap, ParsedKeyStroke } from "../types.js"
import { registerLeader, type LeaderOptions } from "./leader.js"

export interface TimedLeaderOptions extends LeaderOptions {
  timeoutMs?: number
  onArm?: () => void
  onDisarm?: () => void
}

export function registerTimedLeader(manager: ActionMap, options: TimedLeaderOptions): () => void {
  const matchesTrigger = manager.createKeyMatcher(options.trigger)
  const timeoutMs = options.timeoutMs ?? 1500

  let armed = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (!timeout) {
      return
    }

    clearTimeout(timeout)
    timeout = undefined
  }

  const scheduleTimeout = (): void => {
    clearTimer()
    timeout = setTimeout(() => {
      manager.clearPendingSequence()
    }, timeoutMs)
  }

  const syncArmedState = (sequence: readonly ParsedKeyStroke[]): void => {
    const nextArmed = matchesTrigger(sequence[0])
    if (nextArmed) {
      scheduleTimeout()
    } else {
      clearTimer()
    }

    if (nextArmed === armed) {
      return
    }

    armed = nextArmed
    if (armed) {
      options.onArm?.()
      return
    }

    options.onDisarm?.()
  }

  const offLeader = registerLeader(manager, options)
  const offPendingSequenceChange = manager.hook("pendingSequence", (sequence) => {
    syncArmedState(sequence)
  })
  syncArmedState(manager.getPendingSequence())

  const dispose = (): void => {
    clearTimer()
    offPendingSequenceChange()
    offLeader()

    if (!armed) {
      return
    }

    armed = false
    options.onDisarm?.()
  }

  return dispose
}
