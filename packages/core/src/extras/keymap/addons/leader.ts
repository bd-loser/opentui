import type { KeyLike, Keymap } from "../types.js"

export interface LeaderOptions {
  trigger: KeyLike
  name?: string
}

export function registerLeader(keymap: Keymap, options: LeaderOptions): () => void {
  return keymap.registerToken({
    name: options.name ?? "<leader>",
    key: options.trigger,
  })
}
