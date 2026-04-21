import type { Keymap, KeymapEvent, LayerAnalysisContext, ParsedBindingInput, Scope } from "../../index.js"
import { stringifyKeySequence, stringifyKeyStroke } from "../../index.js"

interface UnresolvedCommandWarning<TTarget extends object, TEvent extends KeymapEvent> {
  command: string
  binding: ParsedBindingInput<TTarget, TEvent>
  scope: Scope
  target?: TTarget
}

function warnUnresolvedCommand<TTarget extends object, TEvent extends KeymapEvent>(
  ctx: LayerAnalysisContext<TTarget, TEvent>,
  binding: LayerAnalysisContext<TTarget, TEvent>["bindings"][number],
): void {
  if (typeof binding.command !== "string") {
    return
  }

  if (ctx.checkCommandResolution(binding.command) !== "unresolved") {
    return
  }

  const sequence = stringifyKeySequence(binding.sourceBinding.sequence, { preferDisplay: true })
  const sourceKey =
    typeof binding.sourceBinding.key === "string"
      ? binding.sourceBinding.key
      : stringifyKeyStroke(binding.sourceBinding.key)
  const warning: UnresolvedCommandWarning<TTarget, TEvent> = {
    command: binding.command,
    binding: binding.sourceBinding,
    scope: binding.sourceScope,
    target: binding.sourceTarget,
  }

  ctx.warnOnce(
    `unresolved:${binding.sourceLayerOrder}:${binding.sourceBindingIndex}:${binding.command}:${sourceKey}`,
    "unresolved-command",
    warning,
    `[Keymap] Unresolved command "${binding.command}" for binding "${sequence}" in ${binding.sourceScope} layer`,
  )
}

export function registerUnresolvedCommandWarnings<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.appendLayerAnalyzer((ctx) => {
    for (const binding of ctx.bindings) {
      warnUnresolvedCommand(ctx, binding)
    }
  })
}
