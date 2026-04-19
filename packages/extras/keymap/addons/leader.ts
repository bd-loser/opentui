import type { KeyLike, Keymap, KeymapEvent } from "../types.js"

export interface LeaderOptions {
  trigger: KeyLike
  name?: string
}

export function registerLeader<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
  options: LeaderOptions,
): () => void {
  return keymap.registerToken({
    name: options.name ?? "<leader>",
    key: options.trigger,
  })
}
