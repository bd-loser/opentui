import { type KeymapManager } from "../core.js"
import { registerLeaderState, type LeaderOptions } from "./leader.js"

export interface TimedLeaderOptions extends LeaderOptions {
  timeoutMs?: number
}

export function registerTimedLeader(manager: KeymapManager, options: TimedLeaderOptions): () => void {
  return registerLeaderState(manager, {
    ...options,
    timeoutMs: options.timeoutMs ?? 1500,
    cancelOnEscape: false,
  })
}
