import type { TextNodeRenderable } from "@opentui/core"

export const BrandedMarkerRenderable: unique symbol = Symbol.for("@opentui/solid/MarkerRenderable")

export function isMarkerRenderable(obj: any): obj is TextNodeRenderable {
  return !!obj?.[BrandedMarkerRenderable]
}
