import {
  BaseRenderable,
  RootTextNodeRenderable,
  TextNodeRenderable,
  TextRenderable,
  isTextNodeRenderable,
  type RenderContext,
  type StyledText,
  type TextNodeOptions,
} from "@opentui/core"
import { isMarkerRenderable } from "./marker-brand.js"

export function getTextRenderableParent(node: BaseRenderable | undefined): TextRenderable | undefined {
  if (node instanceof RootTextNodeRenderable || node instanceof SolidRootTextNodeRenderable) {
    return node.textParent
  }

  return undefined
}

function detachMarkerChild(child: TextNodeRenderable): void {
  const parent = child.parent as unknown as BaseRenderable | null
  parent?.remove(child.id)
}

export class SolidTextNodeRenderable extends TextNodeRenderable {
  private markerChildren?: Set<TextNodeRenderable>

  public override get children(): (string | TextNodeRenderable)[] {
    return super.children
  }

  public override set children(children: (string | TextNodeRenderable)[]) {
    const markerChildren = new Set<TextNodeRenderable>()
    for (const child of children) {
      if (isMarkerRenderable(child)) {
        markerChildren.add(child)
      }
    }

    for (const child of this.markerChildren ?? []) {
      if (!markerChildren.has(child) && child.parent === this) {
        child.parent = null
      }
    }

    this.markerChildren = markerChildren.size > 0 ? markerChildren : undefined
    super.children = children
  }

  public override add(obj: TextNodeRenderable | StyledText | string, index?: number): number {
    if (isMarkerRenderable(obj)) {
      detachMarkerChild(obj)

      const insertIndex = index ?? this.children.length
      obj.parent = this
      const children = [...this.children]
      children.splice(insertIndex, 0, obj)
      this.children = children
      return insertIndex
    }

    return super.add(obj, index)
  }

  public override replace(obj: TextNodeRenderable | string, index: number): void {
    const previous = this.children[index]
    if (isMarkerRenderable(obj) || isMarkerRenderable(previous)) {
      if (previous === obj) {
        return
      }

      if (isMarkerRenderable(obj)) {
        detachMarkerChild(obj)
      }

      if (typeof obj !== "string") {
        obj.parent = this
      }
      const children = [...this.children]
      children[index] = obj
      this.children = children
      return
    }

    super.replace(obj, index)
  }

  public override insertBefore(
    child: string | TextNodeRenderable | StyledText,
    anchorNode: TextNodeRenderable | string | unknown,
  ): this {
    if (isMarkerRenderable(child)) {
      if (!anchorNode || !isTextNodeRenderable(anchorNode)) {
        throw new Error("Anchor must be a TextNodeRenderable")
      }

      if (!this.children.includes(anchorNode)) {
        throw new Error("Anchor node not found in children")
      }

      if (child === anchorNode) {
        return this
      }

      detachMarkerChild(child)

      const anchorIndex = this.children.indexOf(anchorNode)
      if (anchorIndex === -1) {
        throw new Error("Anchor node not found in children")
      }

      child.parent = this
      const children = [...this.children]
      children.splice(anchorIndex, 0, child)
      this.children = children
      return this
    }

    return super.insertBefore(child, anchorNode) as this
  }

  public override remove(id: string): this {
    const childIndex = this.getRenderableIndex(id)
    const child = this.children[childIndex]
    if (isMarkerRenderable(child)) {
      const children = [...this.children]
      children.splice(childIndex, 1)
      this.children = children
      return this
    }

    super.remove(id)
    return this
  }

  public override clear(): void {
    for (const child of [...(this.markerChildren ?? [])]) {
      if (isMarkerRenderable(child) && child.parent === this) {
        child.destroy()
      }
    }

    this.children = []
  }
}

export class SolidRootTextNodeRenderable extends SolidTextNodeRenderable {
  public textParent: TextRenderable

  constructor(
    private readonly ctx: RenderContext,
    options: TextNodeOptions,
    textParent: TextRenderable,
  ) {
    super(options)
    this.textParent = textParent
  }

  public override requestRender(): void {
    this.markDirty()
    this.ctx.requestRender()
  }
}

export class SolidTextRenderable extends TextRenderable {
  protected override createRootTextNode(ctx: RenderContext, options: TextNodeOptions): TextNodeRenderable {
    return new SolidRootTextNodeRenderable(ctx, options, this)
  }

  public override destroy(): void {
    this.rootTextNode.clear()
    super.destroy()
  }
}
