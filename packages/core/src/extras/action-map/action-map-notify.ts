import type { ActionMapEvents, ActionMapHookName, ActionMapHooks } from "./types.js"
import type { ActionMapState } from "./action-map-state.js"
import { Emitter } from "./lib/emitter.js"

export class ActionMapNotifier {
  constructor(
    private readonly state: ActionMapState,
    private readonly events: Emitter<ActionMapEvents>,
    private readonly hooks: Emitter<ActionMapHooks>,
  ) {}

  public runWithStateChangeBatch<T>(fn: () => T): T {
    this.state.notify.stateChangeDepth += 1

    try {
      return fn()
    } finally {
      this.state.notify.stateChangeDepth -= 1
      if (this.state.notify.stateChangeDepth === 0) {
        this.flushStateChange()
      }
    }
  }

  public queueStateChange(): void {
    this.state.notify.derivedStateVersion += 1

    if (!this.hooks.has("state")) {
      return
    }

    this.state.notify.stateChangePending = true
    if (this.state.notify.stateChangeDepth === 0 && !this.state.notify.flushingStateChange) {
      this.flushStateChange()
    }
  }

  public emitWarning(message: string): void {
    if (!this.events.has("warning")) {
      console.warn(message)
      return
    }

    this.events.emit("warning", { message })
  }

  public emitError(message: string, cause?: unknown): void {
    if (!this.events.has("error")) {
      if (cause === undefined) {
        console.error(message)
      } else {
        console.error(message, cause)
      }
      return
    }

    this.events.emit("error", cause === undefined ? { message } : { message, cause })
  }

  public reportHookError(name: ActionMapHookName, error: unknown): void {
    if (name === "state") {
      this.emitError("[ActionMap] Error in state change hook:", error)
      return
    }

    if (name === "pendingSequence") {
      this.emitError("[ActionMap] Error in pending sequence hook:", error)
      return
    }

    this.emitError("[ActionMap] Error in unresolved command hook:", error)
  }

  public warnOnce(key: string, message: string): void {
    if (this.state.notify.usedWarningKeys.has(key)) {
      return
    }

    this.state.notify.usedWarningKeys.add(key)
    this.emitWarning(message)
  }

  private flushStateChange(): void {
    if (
      !this.state.notify.stateChangePending ||
      this.state.notify.stateChangeDepth > 0 ||
      this.state.notify.flushingStateChange
    ) {
      return
    }

    this.state.notify.flushingStateChange = true

    try {
      while (this.state.notify.stateChangePending && this.state.notify.stateChangeDepth === 0) {
        this.state.notify.stateChangePending = false
        this.hooks.emit("state")
      }
    } finally {
      this.state.notify.flushingStateChange = false
    }
  }
}
