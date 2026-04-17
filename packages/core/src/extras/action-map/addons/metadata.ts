import type { ActionMap } from "../types.js"

function normalizeMetadataText(fieldName: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`ActionMap metadata field "${fieldName}" must be a string`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`ActionMap metadata field "${fieldName}" cannot be empty`)
  }

  return trimmed
}

export function registerMetadataFields(actionMap: ActionMap): () => void {
  const offBindingFields = actionMap.registerBindingFields({
    desc(value, ctx) {
      ctx.attr("desc", normalizeMetadataText("desc", value))
    },
    group(value, ctx) {
      ctx.attr("group", normalizeMetadataText("group", value))
    },
  })

  const offCommandFields = actionMap.registerCommandFields({
    desc(value, ctx) {
      ctx.attr("desc", normalizeMetadataText("desc", value))
    },
    title(value, ctx) {
      ctx.attr("title", normalizeMetadataText("title", value))
    },
    category(value, ctx) {
      ctx.attr("category", normalizeMetadataText("category", value))
    },
  })

  return () => {
    offCommandFields()
    offBindingFields()
  }
}
