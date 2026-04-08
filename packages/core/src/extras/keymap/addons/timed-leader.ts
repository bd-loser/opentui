import { parseKeyLike, type KeymapManager } from "../core.js"
import { registerLeader, type LeaderOptions } from "./leader.js"

export interface TimedLeaderOptions extends LeaderOptions {
  timeoutMs?: number
  onArm?: () => void
  onDisarm?: () => void
}

function startsWithTrigger(manager: KeymapManager, trigger: ReturnType<typeof parseKeyLike>): boolean {
  const pending = manager.getPendingSequence()
  const head = pending[0]
  if (!head) {
    return false
  }

  return (
    head.name === trigger.name &&
    head.ctrl === trigger.ctrl &&
    head.shift === trigger.shift &&
    head.meta === trigger.meta &&
    head.super === trigger.super
  )
}

export function registerTimedLeader(manager: KeymapManager, options: TimedLeaderOptions): () => void {
  const trigger = parseKeyLike(options.trigger)
  const timeoutMs = options.timeoutMs ?? 1500

  let armed = false
  let disposed = false
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
      if (disposed) {
        return
      }

      manager.clearPendingSequence()
      syncArmedState()
    }, timeoutMs)
  }

  const syncArmedState = (): void => {
    const nextArmed = startsWithTrigger(manager, trigger)
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

  const syncLater = (): void => {
    queueMicrotask(() => {
      if (disposed) {
        return
      }

      syncArmedState()
    })
  }

  const offLeader = registerLeader(manager, options)
  const offHook = manager.onKeyInput(() => {
    syncLater()
  })

  const handleDestroy = (): void => {
    dispose()
  }

  manager.renderer.once("destroy", handleDestroy)

  const dispose = (): void => {
    if (disposed) {
      return
    }

    disposed = true
    clearTimer()
    offHook()
    offLeader()
    manager.renderer.off("destroy", handleDestroy)

    if (!armed) {
      return
    }

    armed = false
    options.onDisarm?.()
  }

  return dispose
}
