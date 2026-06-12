import { afterEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { destroy, run } from "./native-image-demo.js"

const IMAGE_CELLS = "▀▄▌▐▖▗▘▝▚▞▙▛▜▟█"

function countImageCells(frame: string): number {
  return [...frame].filter((char) => IMAGE_CELLS.includes(char)).length
}

describe("native image demo", () => {
  let setup: TestRendererSetup | null = null

  afterEach(() => {
    if (!setup) return
    destroy(setup.renderer)
    setup.renderer.destroy()
    setup = null
  })

  test("loads every format, renders previews, and updates display controls", async () => {
    setup = await createTestRenderer({ width: 120, height: 32 })
    await run(setup.renderer)

    const frame = await setup.waitForFrame(
      (value) => ["PNG", "JPEG", "WEBP", "GIF"].every((format) => value.includes(format)),
      { maxPasses: 40 },
    )
    expect(frame).toContain("NATIVE IMAGE LAB")
    expect(frame).toContain("filesystem path")
    expect(frame).toContain("file: URL")
    expect(frame).toContain("Uint8Array")
    expect(frame).toContain("HTTP response")
    expect(countImageCells(frame)).toBeGreaterThan(100)

    setup.mockInput.pressKey("f")
    setup.mockInput.pressKey("p")
    await setup.flush()
    const updated = setup.captureCharFrame()
    expect(updated).toContain("COVER")
    expect(updated).toContain("KITTY → KITTY")
  })

  test("switches to looping video and back without leaving playback active", async () => {
    setup = await createTestRenderer({ width: 80, height: 24 })
    await run(setup.renderer)
    await setup.waitForFrame((value) => value.includes("LOCAL PNG"), { maxPasses: 40 })

    setup.mockInput.pressKey("v")
    const videoFrame = await setup.waitForFrame(
      (value) => value.includes("FFMPEG  768×1168  24 FPS  AUDIO") && countImageCells(value) > 200,
      { maxPasses: 120 },
    )
    expect(videoFrame).toContain("V  GALLERY")
    const fitCells = countImageCells(videoFrame)
    const advancedFrame = await setup.waitForFrame(
      (value) => value.includes("FFMPEG  768×1168  24 FPS  AUDIO") && value !== videoFrame,
      { maxPasses: 120 },
    )
    expect(advancedFrame).not.toBe(videoFrame)

    setup.mockInput.pressKey("f")
    const coverFrame = await setup.waitForFrame(
      (value) => value.includes("COVER") && countImageCells(value) > fitCells * 2,
      { maxPasses: 120 },
    )
    expect(countImageCells(coverFrame)).toBeGreaterThan(fitCells * 2)

    setup.mockInput.pressKey("v")
    const galleryFrame = await setup.waitForFrame((value) => value.includes("LOCAL PNG"), { maxPasses: 40 })
    expect(galleryFrame).toContain("V  VIDEO")
  }, 15_000)
})
