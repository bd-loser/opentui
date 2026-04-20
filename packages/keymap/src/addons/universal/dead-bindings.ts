import type { Keymap, KeymapEvent, LayerBindingAnalysis, LayerAnalysisContext } from "../../core.js"
import { stringifyKeySequence, stringifyKeyStroke } from "../../core.js"

function isDeadMetadataOnlyBinding<TTarget extends object, TEvent extends KeymapEvent>(
  binding: LayerBindingAnalysis<TTarget, TEvent>,
): boolean {
  if (binding.command !== undefined) {
    return false
  }

  if (binding.event === "release") {
    return true
  }

  return !binding.hasContinuations && !binding.hasCommandAtSequence
}

function warnDeadMetadataOnlyBinding<TTarget extends object, TEvent extends KeymapEvent>(
  ctx: LayerAnalysisContext<TTarget, TEvent>,
  binding: LayerBindingAnalysis<TTarget, TEvent>,
): void {
  const sequence = stringifyKeySequence(binding.sourceBinding.sequence, { preferDisplay: true })
  const sourceKey =
    typeof binding.sourceBinding.key === "string"
      ? binding.sourceBinding.key
      : stringifyKeyStroke(binding.sourceBinding.key)
  const warningKey = `dead-binding:${binding.sourceLayerOrder}:${binding.sourceBindingIndex}:${sourceKey}`

  ctx.warnOnce(
    warningKey,
    "dead-binding",
    {
      binding: binding.sourceBinding,
      scope: binding.sourceScope,
      target: binding.sourceTarget,
    },
    `[Keymap] Binding "${sequence}" in ${binding.sourceScope} layer has no command and no reachable continuations; it will never trigger`,
  )
}

export function registerDeadBindingWarnings<TTarget extends object, TEvent extends KeymapEvent>(
  keymap: Keymap<TTarget, TEvent>,
): () => void {
  return keymap.appendLayerAnalyzer((ctx) => {
    for (const binding of ctx.bindings) {
      if (!isDeadMetadataOnlyBinding(binding)) {
        continue
      }

      warnDeadMetadataOnlyBinding(ctx, binding)
    }
  })
}
