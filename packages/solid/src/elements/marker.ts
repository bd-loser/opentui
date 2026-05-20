import {
  BaseRenderable,
  TextNodeRenderable,
  Yoga,
  type RGBA,
  type BaseRenderableOptions,
  type StyledText,
  type TextChunk,
} from "@opentui/core"
import { BrandedMarkerRenderable, isMarkerRenderable as isMarkerRenderableNode } from "./marker-brand.js"
import { SolidTextNodeRenderable } from "./text.js"

type YogaNode = ReturnType<typeof Yoga.default.Node.create>

export function isMarkerRenderable(obj: any): obj is MarkerRenderable {
  return isMarkerRenderableNode(obj)
}

export class MarkerRenderable extends SolidTextNodeRenderable {
  [BrandedMarkerRenderable] = true

  private yogaNode?: YogaNode
  private yogaNodeFreed: boolean = false
  private destroyed: boolean = false
  public _liveCount: number = 0

  constructor(options: BaseRenderableOptions) {
    super(options)
    this._visible = false
  }

  public get isDestroyed(): boolean {
    return this.destroyed
  }

  public get zIndex(): number {
    return 0
  }

  public get screenX(): number {
    return 0
  }

  public get screenY(): number {
    return 0
  }

  public get width(): number {
    return 0
  }

  public get height(): number {
    return 0
  }

  public getLayoutNode(): YogaNode {
    if (!this.yogaNode || this.yogaNodeFreed) {
      this.yogaNodeFreed = false
      this.yogaNode = Yoga.default.Node.create()
      this.yogaNode.setDisplay(Yoga.Display.None)
    }

    return this.yogaNode
  }

  public updateFromLayout(): void {}

  public updateLayout(): void {}

  public onRemove(): void {}

  public override add(_obj: TextNodeRenderable | StyledText | string, _index?: number): number {
    throw new Error("Can't add children on a marker renderable")
  }

  public override insertBefore(
    _child: string | TextNodeRenderable | StyledText,
    _anchorNode: TextNodeRenderable | string | unknown,
  ): this {
    throw new Error("Can't add children on a marker renderable")
  }

  public override replace(_obj: TextNodeRenderable | string, _index: number): void {
    throw new Error("Can't add children on a marker renderable")
  }

  public override remove(_id: string): this {
    return this
  }

  public override clear(): void {}

  public override getChildren(): TextNodeRenderable[] {
    return []
  }

  public override getChildrenCount(): number {
    return 0
  }

  public override getRenderable(_id: string): TextNodeRenderable | undefined {
    return undefined
  }

  public override findDescendantById(_id: string): TextNodeRenderable | undefined {
    return undefined
  }

  public override gatherWithInheritedStyle(_parentStyle?: {
    fg?: RGBA
    bg?: RGBA
    attributes: number
    link?: { url: string }
  }): TextChunk[] {
    this.markClean()
    return []
  }

  private freeYogaNode(): void {
    if (!this.yogaNode || this.yogaNodeFreed) {
      return
    }

    this.yogaNodeFreed = true

    try {
      this.yogaNode.free()
    } catch {}
  }

  public override destroy(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true

    const parent = this.parent as unknown as BaseRenderable | null
    if (parent) {
      parent.remove(this.id)
    }

    this.freeYogaNode()
    this.parent = null
    this.removeAllListeners()
  }

  public override destroyRecursively(): void {
    this.destroy()
  }
}
