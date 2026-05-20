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
  public override add(obj: TextNodeRenderable | StyledText | string, index?: number): number {
    if (isMarkerRenderable(obj)) {
      detachMarkerChild(obj)

      const insertIndex = index ?? this.children.length
      this.children.splice(insertIndex, 0, obj)
      obj.parent = this
      this.requestRender()
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

      if (isMarkerRenderable(previous) && previous.parent === this) {
        previous.parent = null
      }

      if (isMarkerRenderable(obj)) {
        detachMarkerChild(obj)
      }

      this.children[index] = obj
      if (typeof obj !== "string") {
        obj.parent = this
      }
      this.requestRender()
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

      this.children.splice(anchorIndex, 0, child)
      child.parent = this
      this.requestRender()
      return this
    }

    return super.insertBefore(child, anchorNode) as this
  }

  public override remove(id: string): this {
    const childIndex = this.getRenderableIndex(id)
    const child = this.children[childIndex]
    if (isMarkerRenderable(child)) {
      this.children.splice(childIndex, 1)
      if (child.parent === this) {
        child.parent = null
      }

      this.requestRender()
      return this
    }

    super.remove(id)
    return this
  }

  public override clear(): void {
    for (const child of this.children) {
      if (isMarkerRenderable(child) && child.parent === this) {
        child.parent = null
      }
    }

    super.clear()
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
