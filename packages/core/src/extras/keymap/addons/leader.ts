import {
  normalizeEventKeyStroke,
  parseKeyLike,
  type KeyLike,
  type KeymapEventData,
  type KeymapManager,
} from "../core.js"

export interface LeaderOptions {
  trigger: KeyLike
  token?: string
  data?: KeymapEventData
  onArm?: () => void
  onDisarm?: () => void
}

interface LeaderRegistrationOptions extends LeaderOptions {
  timeoutMs?: number
  cancelOnEscape: boolean
}

function isSameStroke(event: ReturnType<typeof normalizeEventKeyStroke>, trigger: ReturnType<typeof parseKeyLike>["stroke"]): boolean {
  return (
    event.name === trigger.name &&
    event.ctrl === trigger.ctrl &&
    event.shift === trigger.shift &&
    event.meta === trigger.meta &&
    event.super === trigger.super
  )
}

function resolveLeaderOptions(options: LeaderOptions): { data: KeymapEventData; token: string; trigger: ReturnType<typeof parseKeyLike>["stroke"] } {
  const { stroke, requires } = parseKeyLike(options.trigger, new Map())
  if (Object.keys(requires).length > 0) {
    throw new Error("Leader trigger does not support key tokens")
  }

  return {
    trigger: stroke,
    token: options.token ?? "<leader>",
    data: options.data ?? { prefix: "leader" },
  }
}

function applyLeaderData(setData: (name: string, value: unknown) => void, data: KeymapEventData): void {
  for (const [name, value] of Object.entries(data)) {
    setData(name, value)
  }
}

export function registerLeaderState(manager: KeymapManager, options: LeaderRegistrationOptions): () => void {
  const resolved = resolveLeaderOptions(options)
  let armed = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clearTimer = (): void => {
    if (!timeout) {
      return
    }

    clearTimeout(timeout)
    timeout = undefined
  }

  const disarm = (): void => {
    if (!armed) {
      clearTimer()
      return
    }

    armed = false
    clearTimer()
    options.onDisarm?.()
  }

  const arm = (): void => {
    clearTimer()
    armed = true
    options.onArm?.()

    if (options.timeoutMs === undefined) {
      return
    }

    timeout = setTimeout(() => {
      disarm()
    }, options.timeoutMs)
  }

  const offToken = manager.registerToken({
    token: resolved.token,
    data: resolved.data,
  })

  const offHook = manager.onKeyInput(({ event, consume, setData }) => {
    if (armed) {
      if (options.cancelOnEscape && event.name === "escape") {
        disarm()
        consume()
        return
      }

      disarm()
      applyLeaderData(setData, resolved.data)
      return
    }

    const stroke = normalizeEventKeyStroke(event)
    if (!isSameStroke(stroke, resolved.trigger)) {
      return
    }

    arm()
    consume()
  })

  return () => {
    offHook()
    offToken()
    clearTimer()
  }
}

export function registerLeader(manager: KeymapManager, options: LeaderOptions): () => void {
  return registerLeaderState(manager, {
    ...options,
    cancelOnEscape: true,
  })
}
