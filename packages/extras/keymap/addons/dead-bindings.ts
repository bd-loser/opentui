import type {
  CompiledBinding,
  Keymap,
  KeymapEvent,
  KeySequencePart,
  LayerAnalysisContext,
  SequenceNode,
} from "../types.js"
import { stringifyKeySequence, stringifyKeyStroke } from "../index.js"

function getSequenceNode<TTarget extends object, TEvent extends KeymapEvent>(
  root: SequenceNode<TTarget, TEvent>,
  sequence: readonly KeySequencePart[],
): SequenceNode<TTarget, TEvent> | undefined {
  let node: SequenceNode<TTarget, TEvent> | undefined = root

  for (const part of sequence) {
    node = node.children.get(part.matchKey)
    if (!node) {
      return undefined
    }
  }

  return node
}

function isDeadMetadataOnlyBinding<TTarget extends object, TEvent extends KeymapEvent>(
  ctx: LayerAnalysisContext<TTarget, TEvent>,
  binding: CompiledBinding<TTarget, TEvent>,
): boolean {
  if (binding.command !== undefined) {
    return false
  }

  if (binding.event === "release") {
    return true
  }

  const node = getSequenceNode(ctx.root, binding.sequence)
  if (!node) {
    return false
  }

  if (node.children.size > 0) {
    return false
  }

  if (node.bindings.some((candidate) => candidate.command !== undefined)) {
    return false
  }

  return true
}

function warnDeadMetadataOnlyBinding<TTarget extends object, TEvent extends KeymapEvent>(
  ctx: LayerAnalysisContext<TTarget, TEvent>,
  binding: CompiledBinding<TTarget, TEvent>,
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
    for (const binding of ctx.compiledBindings) {
      if (!isDeadMetadataOnlyBinding(ctx, binding)) {
        continue
      }

      warnDeadMetadataOnlyBinding(ctx, binding)
    }
  })
}
