import { describe, expect, test } from "bun:test"

import {
  calculateVideoGeometry,
  calculateVideoPlaybackFps,
  calculateVideoTickFps,
  createAdaptiveVideoQualityState,
  normalizeVideoTime,
  updateAdaptiveVideoQuality,
  VideoRenderable,
} from "../renderables/Video.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { setRendererCapabilities } from "../testing/terminal-capabilities.js"

describe("VideoRenderable geometry", () => {
  test("fits portrait video using physical cell aspect", () => {
    const geometry = calculateVideoGeometry({
      fit: "fit",
      sourceWidth: 768,
      sourceHeight: 1168,
      targetWidth: 80,
      targetHeight: 18,
      terminalWidth: 80,
      terminalHeight: 24,
      resolution: null,
    })
    expect(geometry).toEqual({
      cellWidth: 24,
      cellHeight: 18,
      pixelWidth: 48,
      pixelHeight: 72,
      decodeWidth: 48,
      decodeHeight: 72,
    })
  })

  test("cover and fill use the complete measured destination", () => {
    const base = {
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 40,
      targetHeight: 10,
      terminalWidth: 100,
      terminalHeight: 30,
      resolution: { width: 1000, height: 600 },
    }
    expect(calculateVideoGeometry({ ...base, fit: "cover" })).toEqual({
      cellWidth: 40,
      cellHeight: 10,
      pixelWidth: 400,
      pixelHeight: 200,
      decodeWidth: 400,
      decodeHeight: 200,
    })
    expect(calculateVideoGeometry({ ...base, fit: "fill" })).toEqual({
      cellWidth: 40,
      cellHeight: 10,
      pixelWidth: 400,
      pixelHeight: 200,
      decodeWidth: 400,
      decodeHeight: 200,
    })
  })

  test("never upscales native decode above source resolution", () => {
    expect(
      calculateVideoGeometry({
        fit: "fit",
        sourceWidth: 768,
        sourceHeight: 1168,
        targetWidth: 80,
        targetHeight: 40,
        terminalWidth: 80,
        terminalHeight: 40,
        resolution: { width: 1536, height: 2346 },
      }),
    ).toMatchObject({ pixelWidth: 1536, pixelHeight: 2346, decodeWidth: 765, decodeHeight: 1168 })
  })
})

describe("VideoRenderable timeline", () => {
  test("normalizes clamped and looped subsecond positions", () => {
    expect(normalizeVideoTime(1.375, 6.04, false)).toBe(1.375)
    expect(normalizeVideoTime(9, 6.04, false)).toBe(6.04)
    expect(normalizeVideoTime(-0.25, 6.04, false)).toBe(0)
    expect(normalizeVideoTime(7.29, 6.04, true)).toBeCloseTo(1.25, 12)
    expect(normalizeVideoTime(6.04, 6.04, true)).toBeCloseTo(0, 12)
    expect(() => normalizeVideoTime(Number.NaN, 1, false)).toThrow("finite")
  })

  test("caps presentation at 30 FPS without raising slower source rates", () => {
    expect(calculateVideoPlaybackFps(60, 60)).toBe(30)
    expect(calculateVideoPlaybackFps(30, 60)).toBe(30)
    expect(calculateVideoPlaybackFps(24, 60)).toBe(24)
    expect(calculateVideoPlaybackFps(0, 20)).toBe(20)
  })

  test("services native audio at least 15 times per second without raising video FPS", () => {
    expect(calculateVideoTickFps(1, 30, true)).toBe(15)
    expect(calculateVideoTickFps(10, 30, true)).toBe(15)
    expect(calculateVideoTickFps(24, 30, true)).toBe(24)
    expect(calculateVideoTickFps(1, 30, false)).toBe(1)
  })
})

describe("VideoRenderable adaptive quality", () => {
  test("exposes its active quality tier and effective protocol", async () => {
    const renderer = (await createTestRenderer({})).renderer
    const video = new VideoRenderable(renderer, { source: "unused.mp4" })
    try {
      expect(video.qualityTier).toEqual({
        index: 0,
        total: 6,
        label: "RGB888",
        bitsPerChannel: [8, 8, 8],
        lossless: true,
        compressionLevel: 1,
        predictor: "paeth",
      })
      expect(video.effectiveProtocol).toBe("blocks")
      setRendererCapabilities(renderer, { kitty_graphics: true })
      expect(video.effectiveProtocol).toBe("kitty")
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })

  test("downgrades CPU quality after sustained frame-budget pressure", () => {
    let state = createAdaptiveVideoQualityState()
    for (let serial = 1n; serial <= 8n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 30,
        frameBudgetMs: 40,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(1)
  })

  test("starts at the highest tier and can downgrade through all six tiers", () => {
    let state = createAdaptiveVideoQualityState()
    expect(state.tier).toBe(0)
    let serial = 0n
    for (let expectedTier = 1; expectedTier <= 5; expectedTier++) {
      state = { ...state, cooldownSamples: 0 }
      for (let sample = 0; sample < 8; sample++) {
        serial++
        state = updateAdaptiveVideoQuality(state, {
          updateTimeMs: 30,
          frameBudgetMs: 40,
          frameSerial: serial,
          expectedFrameStep: 1n,
          backpressureCount: 0,
        })
      }
      expect(state.tier).toBe(expectedTier)
    }
  })

  test("steps down to RGB666 under output backpressure", () => {
    let state = createAdaptiveVideoQualityState()
    for (let serial = 1n; serial <= 8n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 40,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: Number(serial),
      })
    }
    expect(state.tier).toBe(1)
  })

  test("does not downgrade for measured lossless cost with normal timing jitter", () => {
    let state = createAdaptiveVideoQualityState()
    for (let serial = 1n; serial <= 240n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: serial % 10n === 0n ? 22 : 16.7,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(0)
  })

  test("transient pressure decays instead of accumulating into a downgrade", () => {
    let state = createAdaptiveVideoQualityState()
    let backpressureCount = 0
    for (let serial = 1n; serial <= 120n; serial++) {
      if (serial % 3n === 0n) backpressureCount++
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 40,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount,
      })
    }
    expect(state.tier).toBe(0)
    expect(state.overloadSamples).toBe(1)
  })

  test("upgrades only after prolonged stable headroom", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 1 }
    for (let serial = 1n; serial <= 119n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 5,
        frameBudgetMs: 40,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(1)
    state = updateAdaptiveVideoQuality(state, {
      updateTimeMs: 5,
      frameBudgetMs: 40,
      frameSerial: 120n,
      expectedFrameStep: 1n,
      backpressureCount: 0,
    })
    expect(state.tier).toBe(0)
  })

  test("recovers tiers that sustain 30 FPS without meeting the obsolete 35% gate", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 2 }
    for (let serial = 1n; serial <= 120n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 13.3,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(1)
  })

  test("recovers a 60 FPS source through normal 30 FPS cadence jitter", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 2 }
    let serial = 0n
    for (let sample = 0; sample < 120; sample++) {
      serial += sample % 3 === 2 ? 3n : 2n
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 13.3,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(1)
  })

  test("retains recovery progress across an isolated delayed presentation", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 2 }
    let serial = 0n
    for (let sample = 0; sample < 80; sample++) {
      serial += 2n
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 13.3,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount: 0,
      })
    }
    serial += 4n
    state = updateAdaptiveVideoQuality(state, {
      updateTimeMs: 13.3,
      frameBudgetMs: 1000 / 30,
      frameSerial: serial,
      expectedFrameStep: 2n,
      backpressureCount: 0,
    })
    expect(state.headroomSamples).toBe(76)
    for (let sample = 0; sample < 44; sample++) {
      serial += 2n
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 13.3,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(1)
  })

  test("sustained source-frame loss still prevents recovery and downgrades", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 1 }
    let serial = 0n
    for (let sample = 0; sample < 9; sample++) {
      serial += 4n
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(2)
    expect(state.headroomSamples).toBe(0)
  })

  test("does not recover without enough CPU margin for the next tier", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 2 }
    for (let serial = 1n; serial <= 240n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 17,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(2)
  })

  test("treats two source frames per update as expected for a 60 to 30 FPS cap", () => {
    let state = createAdaptiveVideoQualityState()
    for (const serial of [2n, 4n, 6n]) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 5,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(0)
    expect(state.overloadSamples).toBe(0)
  })
})
