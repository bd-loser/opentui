import type { KeyLike, ActionMap } from "../types.js"

export interface LeaderOptions {
  trigger: KeyLike
  name?: string
}

export function registerLeader(manager: ActionMap, options: LeaderOptions): () => void {
  return manager.registerToken({
    name: options.name ?? "<leader>",
    key: options.trigger,
  })
}
