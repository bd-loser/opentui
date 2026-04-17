import type { ActionMap, ParsedKeyStroke } from "../types.js"
import { parseKeyLike } from "../lib/default-parser.js"
import { registerLeader, type LeaderOptions } from "./leader.js"

export interface TimedLeaderOptions extends LeaderOptions {
  timeoutMs?: number
  onArm?: () => void
  onDisarm?: () => void
}

function startsWithTrigger(sequence: readonly ParsedKeyStroke[], trigger: ParsedKeyStroke): boolean {
  const head = sequence[0]
  if (!head) {
    return false
  }

  return (
    head.name === trigger.name &&
    head.ctrl === trigger.ctrl &&
    head.shift === trigger.shift &&
    head.meta === trigger.meta &&
    head.super === trigger.super &&
    (head.hyper ?? false) === (trigger.hyper ?? false)
  )
}

export function registerTimedLeader(manager: ActionMap, options: TimedLeaderOptions): () => void {
  const trigger = parseKeyLike(options.trigger)
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
    const nextArmed = startsWithTrigger(sequence, trigger)
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
