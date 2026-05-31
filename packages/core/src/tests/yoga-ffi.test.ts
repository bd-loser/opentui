import { describe, expect, test } from "bun:test"
import Yoga, { Align, Direction, Edge, FlexDirection, MeasureMode, PositionType, Unit } from "../yoga.js"

describe("native Yoga FFI facade", () => {
  test("computes a basic flex layout", () => {
    const config = Yoga.Config.create()
    config.setUseWebDefaults(false)
    config.setPointScaleFactor(1)

    const root = Yoga.Node.create(config)
    const child = Yoga.Node.create(config)

    root.setFlexDirection(FlexDirection.Row)
    root.setWidth(100)
    root.setHeight(100)
    child.setFlexGrow(1)
    root.insertChild(child, 0)

    root.calculateLayout(undefined, undefined, Direction.LTR)

    expect(child.getComputedLayout()).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 100, height: 100 })
    expect(root.isDirty()).toBe(false)

    root.freeRecursive()
    config.free()
  })

  test("supports percentage margins and RTL computed edges", () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setHeight(100)
    root.setMargin(Edge.Start, "10%")

    root.calculateLayout(100, 100, Direction.LTR)
    expect(root.getComputedMargin(Edge.Left)).toBe(10)
    expect(root.getComputedMargin(Edge.Right)).toBe(0)

    root.calculateLayout(100, 100, Direction.RTL)
    expect(root.getComputedMargin(Edge.Left)).toBe(0)
    expect(root.getComputedMargin(Edge.Right)).toBe(10)

    root.freeRecursive()
  })

  test("packs style values with Yoga-compatible units", () => {
    const node = Yoga.Node.create()

    expect(node.getFlexBasis().unit).toBe(Unit.Auto)

    node.setFlexBasis(10)
    expect(node.getFlexBasis()).toEqual({ unit: Unit.Point, value: 10 })

    node.setFlexBasisAuto()
    expect(node.getFlexBasis().unit).toBe(Unit.Auto)

    node.setWidth("50%")
    expect(node.getWidth()).toEqual({ unit: Unit.Percent, value: 50 })

    node.freeRecursive()
  })

  test("runs JS measure callbacks through the native trampoline", () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setHeight(100)
    root.setAlignItems(Align.FlexStart)

    let calls = 0
    const measured = Yoga.Node.create()
    measured.setMeasureFunc((width, widthMode, height, heightMode) => {
      calls++
      expect(width).toBe(100)
      expect(widthMode).toBe(MeasureMode.AtMost)
      expect(height).toBe(100)
      expect(heightMode).toBe(MeasureMode.AtMost)
      return { width: 40, height: 12 }
    })

    root.insertChild(measured, 0)
    root.calculateLayout(undefined, undefined, Direction.LTR)

    expect(calls).toBe(1)
    expect(measured.getComputedWidth()).toBe(40)
    expect(measured.getComputedHeight()).toBe(12)

    root.freeRecursive()
  })

  test("handles incomplete measure dimensions like the previous Yoga binding", () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setHeight(100)

    const heightOnly = Yoga.Node.create()
    const widthOnly = Yoga.Node.create()
    const empty = Yoga.Node.create()

    root.insertChild(heightOnly, root.getChildCount())
    root.insertChild(widthOnly, root.getChildCount())
    root.insertChild(empty, root.getChildCount())

    heightOnly.setMeasureFunc(() => ({ width: undefined as unknown as number, height: 10 }))
    widthOnly.setMeasureFunc(() => ({ width: 10, height: undefined as unknown as number }))
    empty.setMeasureFunc(() => ({}) as { width: number; height: number })

    root.calculateLayout(undefined, undefined, Direction.LTR)

    expect(heightOnly.getComputedWidth()).toBe(100)
    expect(heightOnly.getComputedHeight()).toBe(10)
    expect(widthOnly.getComputedWidth()).toBe(100)
    expect(widthOnly.getComputedHeight()).toBe(0)
    expect(empty.getComputedWidth()).toBe(100)
    expect(empty.getComputedHeight()).toBe(0)

    root.freeRecursive()
  })

  test("matches Yoga computed trailing position fields", () => {
    const root = Yoga.Node.create()
    root.setFlexDirection(FlexDirection.Row)
    root.setWidth(100)
    root.setHeight(10)

    const child = Yoga.Node.create()
    child.setWidth(10)
    child.setHeight(10)
    root.insertChild(child, 0)

    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(child.getComputedLayout()).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 10, height: 10 })

    child.setPosition(Edge.Right, 5)
    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(child.getComputedLayout()).toEqual({ left: -5, top: 0, right: -5, bottom: 0, width: 10, height: 10 })

    child.setPositionType(PositionType.Absolute)
    child.setPosition(Edge.Bottom, 7)
    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(child.getComputedLayout()).toEqual({ left: 85, top: -7, right: -5, bottom: -7, width: 10, height: 10 })

    root.freeRecursive()
  })

  test("resolves flex shorthand like Yoga", () => {
    const root = Yoga.Node.create()
    root.setFlexDirection(FlexDirection.Row)
    root.setWidth(100)
    root.setHeight(10)

    const child = Yoga.Node.create()
    child.setFlex(1)
    root.insertChild(child, 0)

    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(child.getComputedWidth()).toBe(100)

    child.setFlexGrow(0)
    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(child.getComputedWidth()).toBe(0)

    child.setFlexGrow(undefined)
    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(child.getComputedWidth()).toBe(100)

    root.freeRecursive()
  })

  test("resets undefined style values", () => {
    const node = Yoga.Node.create()

    node.setWidth(10)
    node.setWidth(undefined)
    expect(node.getWidth().unit).toBe(Unit.Undefined)

    node.setFlexGrow(2)
    node.setFlexGrow(undefined)
    expect(node.getFlexGrow()).toBe(0)

    node.setAspectRatio(2)
    node.setAspectRatio(undefined)
    expect(Number.isNaN(node.getAspectRatio())).toBe(true)

    node.freeRecursive()
  })

  test("applies aspect ratio when one axis is definite", () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setHeight(100)

    const child = Yoga.Node.create()
    child.setHeight(10)
    child.setAspectRatio(2)
    root.insertChild(child, 0)

    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(child.getComputedWidth()).toBe(20)
    expect(child.getComputedHeight()).toBe(10)

    root.freeRecursive()
  })

  test("rerounds cached layouts when point scale factor changes", () => {
    const config = Yoga.Config.create()
    config.setPointScaleFactor(1)

    const root = Yoga.Node.create(config)
    root.setWidth(10.25)
    root.setHeight(10)

    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(root.getComputedWidth()).toBe(10)

    config.setPointScaleFactor(2)
    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(root.getComputedWidth()).toBe(10.5)

    root.freeRecursive()
    config.free()
  })
})
