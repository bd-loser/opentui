import type { KeyLike, ActionMap } from "../types.js"

export interface LeaderOptions {
  trigger: KeyLike
  token?: string
}

export function registerLeader(manager: ActionMap, options: LeaderOptions): () => void {
  return manager.registerToken({
    token: options.token ?? "<leader>",
    key: options.trigger,
  })
}
