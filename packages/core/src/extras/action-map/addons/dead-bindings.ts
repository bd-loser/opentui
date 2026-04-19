import type { ActionMap, CompiledBinding, LayerAnalysisContext, ParsedKeyPart, SequenceNode } from "../types.js"
import { stringifyKeySequence, stringifyKeyStroke } from "../index.js"

function getSequenceNode(root: SequenceNode, sequence: readonly ParsedKeyPart[]): SequenceNode | undefined {
  let node: SequenceNode | undefined = root

  for (const part of sequence) {
    node = node.children.get(part.matchKey)
    if (!node) {
      return undefined
    }
  }

  return node
}

function isDeadMetadataOnlyBinding(ctx: LayerAnalysisContext, binding: CompiledBinding): boolean {
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

function warnDeadMetadataOnlyBinding(ctx: LayerAnalysisContext, binding: CompiledBinding): void {
  const sequence = stringifyKeySequence(binding.sourceBinding.sequence, { preferDisplay: true })
  const sourceKey =
    typeof binding.sourceBinding.key === "string"
      ? binding.sourceBinding.key
      : stringifyKeyStroke(binding.sourceBinding.key)
  const warningKey = `dead-binding:${binding.sourceLayerOrder}:${binding.sourceBindingIndex}:${sourceKey}`

  ctx.warnOnce(
    warningKey,
    `[ActionMap] Binding "${sequence}" in ${binding.sourceScope} layer has no command and no reachable continuations; it will never trigger`,
  )
}

export function registerDeadBindingWarnings(actionMap: ActionMap): () => void {
  return actionMap.appendLayerAnalyzer((ctx) => {
    for (const binding of ctx.compiledBindings) {
      if (!isDeadMetadataOnlyBinding(ctx, binding)) {
        continue
      }

      warnDeadMetadataOnlyBinding(ctx, binding)
    }
  })
}
