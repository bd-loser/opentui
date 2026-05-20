import { afterEach, describe, expect, it } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createSignal } from "solid-js"
import { createMarkerNode, insert, SolidTextRenderable, testRender } from "../index.js"

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

function trackYogaFree(marker: ReturnType<typeof createMarkerNode>): () => number {
  const layoutNode = marker.getLayoutNode()
  const originalFree = layoutNode.free.bind(layoutNode)
  const writableLayoutNode = layoutNode as typeof layoutNode & { free: () => void }
  let freeCallCount = 0

  writableLayoutNode.free = () => {
    freeCallCount++
    originalFree()
  }

  return () => freeCallCount
}

describe("marker text parents", () => {
  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
      testSetup = undefined
    }
  })

  it("moves a marker between JSX text parents", async () => {
    let textA!: SolidTextRenderable
    let textB!: SolidTextRenderable
    const marker = createMarkerNode()
    const [target, setTarget] = createSignal<"a" | "b">("a")

    testSetup = await testRender(
      () => (
        <box>
          <text ref={textA}>{target() === "a" ? marker : null}</text>
          <text ref={textB}>{target() === "b" ? marker : null}</text>
        </box>
      ),
      { width: 40, height: 8 },
    )

    await testSetup.renderOnce()

    expect(textA).toBeInstanceOf(SolidTextRenderable)
    expect(textB).toBeInstanceOf(SolidTextRenderable)
    expect(textA.getTextChildren()).toHaveLength(1)
    expect(textA.getTextChildren()[0]).toBe(marker)
    expect(textB.getTextChildren()).toHaveLength(0)
    expect(marker.parent).toBe(textA.textNode)
    expect(marker.isDestroyed).toBe(false)

    setTarget("b")
    await testSetup.renderOnce()
    await Bun.sleep(0)

    expect(textA.getTextChildren()).toHaveLength(0)
    expect(textB.getTextChildren()).toHaveLength(1)
    expect(textB.getTextChildren()[0]).toBe(marker)
    expect(marker.parent).toBe(textB.textNode)
    expect(marker.isDestroyed).toBe(false)
  })

  it("destroys marker children when a text parent is destroyed", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 })
    const text = new SolidTextRenderable(setup.renderer, {
      id: "marker-text-destroy-parent",
      width: 20,
      height: 1,
    })
    const marker = createMarkerNode()

    try {
      setup.renderer.root.add(text)
      insert(text, marker)

      expect(text.getTextChildren()).toHaveLength(1)
      expect(text.getTextChildren()[0]).toBe(marker)
      expect(marker.parent).toBe(text.textNode)

      text.destroyRecursively()
      await Bun.sleep(0)

      expect(text.getTextChildren()).toHaveLength(0)
      expect(marker.parent).toBeNull()
      expect(marker.isDestroyed).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("frees a marker Yoga node after moving from layout to text and destroying text", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 })
    const layoutParent = new BoxRenderable(setup.renderer, {
      id: "marker-layout-parent",
      width: 20,
      height: 1,
    })
    const textParent = new SolidTextRenderable(setup.renderer, {
      id: "marker-text-parent",
      width: 20,
      height: 1,
    })
    const marker = createMarkerNode()

    try {
      setup.renderer.root.add(layoutParent)
      setup.renderer.root.add(textParent)
      insert(layoutParent, marker)
      const freeCallCount = trackYogaFree(marker)

      insert(textParent, marker)

      expect(layoutParent.getChildren()).toHaveLength(0)
      expect(textParent.getTextChildren()).toHaveLength(1)
      expect(textParent.getTextChildren()[0]).toBe(marker)
      expect(marker.parent).toBe(textParent.textNode)

      textParent.destroyRecursively()
      await Bun.sleep(0)

      expect(marker.parent).toBeNull()
      expect(marker.isDestroyed).toBe(true)
      expect(freeCallCount()).toBe(1)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("warns when inserting a marker into a core TextRenderable", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 })
    const text = new TextRenderable(setup.renderer, {
      id: "core-text-marker-parent",
      width: 20,
      height: 1,
    })
    const marker = createMarkerNode()
    const originalWarn = console.warn
    const warnings: unknown[][] = []

    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      setup.renderer.root.add(text)
      insert(text, marker)

      expect(warnings.some(([message]) => String(message).includes("Markers are not supported in core Text"))).toBe(
        true,
      )
    } finally {
      console.warn = originalWarn
      marker.destroy()
      setup.renderer.destroy()
    }
  })
})
