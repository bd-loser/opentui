import { describe, expect, test } from "bun:test"

import {
  calculateVideoGeometry,
  calculateVideoPlaybackFps,
  createAdaptiveVideoQualityState,
  normalizeVideoTime,
  updateAdaptiveVideoQuality,
} from "../renderables/Video.js"

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
})

describe("VideoRenderable adaptive quality", () => {
  test("downgrades CPU quality after sustained frame-budget pressure", () => {
    let state = createAdaptiveVideoQualityState()
    for (let serial = 1n; serial <= 3n; serial++) {
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

  test("skips the byte-heavy CPU tier under output backpressure", () => {
    let state = createAdaptiveVideoQualityState()
    for (let serial = 1n; serial <= 3n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 40,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: Number(serial),
      })
    }
    expect(state.tier).toBe(2)
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
