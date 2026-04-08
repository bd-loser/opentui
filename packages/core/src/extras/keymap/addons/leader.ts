import { type KeyLike, type KeymapManager } from "../core.js"

export interface LeaderOptions {
  trigger: KeyLike
  token?: string
}

export function registerLeader(manager: KeymapManager, options: LeaderOptions): () => void {
  return manager.registerToken({
    token: options.token ?? "<leader>",
    key: options.trigger,
  })
}
