import type { KeyLike, ActionMap } from "../types.js"

export interface LeaderOptions {
  trigger: KeyLike
  name?: string
}

export function registerLeader(actionMap: ActionMap, options: LeaderOptions): () => void {
  return actionMap.registerToken({
    name: options.name ?? "<leader>",
    key: options.trigger,
  })
}
