import { describe, expect, mock, test } from "bun:test"
import { fileURLToPath } from "node:url"

import {
  calculateVideoGeometry,
  calculateAdaptiveVideoPlaybackFps,
  calculateVideoFrameStep,
  calculateVideoPlaybackFps,
  calculateVideoTickFps,
  createAdaptiveVideoQualityState,
  normalizeVideoTime,
  updateAdaptiveVideoQuality,
  VideoRenderable,
} from "../renderables/Video.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
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

  test("reduces presentation cadence through measured rate tiers", () => {
    expect(calculateAdaptiveVideoPlaybackFps(60, 30, 0)).toBe(30)
    expect(calculateAdaptiveVideoPlaybackFps(60, 30, 1)).toBe(24)
    expect(calculateAdaptiveVideoPlaybackFps(60, 30, 3)).toBe(15)
    expect(calculateAdaptiveVideoPlaybackFps(60, 30, 6)).toBe(7.5)
    expect(calculateAdaptiveVideoPlaybackFps(60, 30, 8)).toBe(3.75)
  })

  test("accounts for intentional source-frame advances at reduced display cadence", () => {
    expect(calculateVideoFrameStep(60, 30)).toBe(2n)
    expect(calculateVideoFrameStep(60, 24)).toBe(3n)
    expect(calculateVideoFrameStep(60, 20)).toBe(3n)
    expect(calculateVideoFrameStep(60, 15)).toBe(4n)
  })

  test("does not treat reduced-cadence 60 FPS playback as sustained frame loss", () => {
    let state = {
      ...createAdaptiveVideoQualityState(),
      tier: 1,
      presentationRateTier: 3,
    }
    let serial = 0n
    for (let sample = 0; sample < 420; sample++) {
      serial += 4n
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 1000 / 15,
        frameSerial: serial,
        expectedFrameStep: calculateVideoFrameStep(60, 15),
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBeLessThanOrEqual(1)
    expect(state.presentationRateTier).toBeLessThan(3)
  })

  test("stores a finite millisecond A/V sync offset without opening media", async () => {
    const renderer = (await createTestRenderer({})).renderer
    const video = new VideoRenderable(renderer, { source: "unused.mp4", avSyncOffsetMs: 75.25 })
    try {
      expect(video.avSyncOffsetMs).toBe(75.25)
      video.avSyncOffsetMs = -30
      expect(video.avSyncOffsetMs).toBe(-30)
      expect(() => {
        video.avSyncOffsetMs = Number.NaN
      }).toThrow("safe number of microseconds")
      expect(() => {
        video.avSyncOffsetMs = Number.MAX_VALUE
      }).toThrow("safe number of microseconds")
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })
})

describe("VideoRenderable adaptive quality", () => {
  test("exposes its active quality tier and effective protocol", async () => {
    const renderer = (await createTestRenderer({})).renderer
    const video = new VideoRenderable(renderer, { source: "unused.mp4" })
    try {
      expect(video.qualityTier).toEqual({
        index: 0,
        total: 8,
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
        updateTimeMs: 42,
        frameBudgetMs: 40,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(1)
  })

  test("does not downgrade when measured preparation stays within the frame budget", () => {
    let state = createAdaptiveVideoQualityState()
    for (let serial = 1n; serial <= 240n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: serial % 30n === 0n ? 25 : 23.5,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(0)
    expect(state.presentationRateTier).toBe(0)
  })

  test("starts at the highest tier and can downgrade through all eight tiers", () => {
    let state = createAdaptiveVideoQualityState()
    expect(state.tier).toBe(0)
    let serial = 0n
    for (let expectedTier = 1; expectedTier <= 7; expectedTier++) {
      state = { ...state, cooldownSamples: 0 }
      for (let sample = 0; sample < 8; sample++) {
        serial++
        state = updateAdaptiveVideoQuality(state, {
          updateTimeMs: 42,
          frameBudgetMs: 40,
          frameSerial: serial,
          expectedFrameStep: 1n,
          backpressureCount: 0,
        })
      }
      expect(state.tier).toBe(expectedTier)
    }
  })

  test("reduces color quality before presentation cadence under output backpressure", () => {
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
    expect(state.presentationRateTier).toBe(0)
    expect(state.nextTransportReduction).toBe("cadence")
  })

  test("does not repeatedly reduce quality for one undrained backpressure episode", () => {
    let state = createAdaptiveVideoQualityState()
    let serial = 0n
    for (let sample = 1; sample <= 240; sample++) {
      serial += 2n
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount: sample,
      })
    }
    expect(state.tier).toBe(1)
    expect(state.presentationRateTier).toBe(0)
    expect(state.awaitingTransportRecovery).toBe(true)
  })

  test("alternates cadence after output recovers and a new pressure episode begins", () => {
    let state = createAdaptiveVideoQualityState()
    let serial = 0n
    let backpressureCount = 0
    for (let sample = 0; sample < 8; sample++) {
      serial += 2n
      backpressureCount++
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount,
      })
    }
    for (let sample = 0; sample < 120; sample++) {
      serial += 2n
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount,
      })
    }
    for (let sample = 0; sample < 30; sample++) {
      serial += 2n
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount,
      })
    }
    for (let sample = 0; sample < 8; sample++) {
      serial += 2n
      backpressureCount++
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount,
      })
    }
    expect(state.tier).toBe(0)
    expect(state.presentationRateTier).toBe(1)
    expect(state.nextTransportReduction).toBe("quality")
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

  test("recovers at the measured lossless RGB888 processing cost", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 1 }
    for (let serial = 1n; serial <= 120n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 19.1,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(0)
  })

  test("recovers at the measured complex-scene processing cost", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 1 }
    for (let serial = 1n; serial <= 120n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 24,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 2n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(0)
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

  test("does not penalize recovery for an isolated decoded-frame catch-up", () => {
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
    expect(state.headroomSamples).toBe(81)
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

  test("does not adapt quality from decoded-frame catch-up alone", () => {
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
    expect(state.tier).toBe(1)
    expect(state.presentationRateTier).toBe(0)
    expect(state.headroomSamples).toBe(9)
  })

  test("only reduces color quality after reaching the minimum presentation cadence", () => {
    let state = {
      ...createAdaptiveVideoQualityState(),
      presentationRateTier: 8,
    }
    for (let serial = 1n; serial <= 8n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 10,
        frameBudgetMs: 1000 / 3.75,
        frameSerial: serial,
        expectedFrameStep: 16n,
        backpressureCount: Number(serial),
      })
    }
    expect(state.presentationRateTier).toBe(8)
    expect(state.tier).toBe(1)
  })

  test("does not recover without a ten-percent CPU margin for the next tier", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 2 }
    for (let serial = 1n; serial <= 240n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 31,
        frameBudgetMs: 1000 / 30,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(2)
  })

  test("does not carry overload pressure through a tier cooldown", () => {
    let state = { ...createAdaptiveVideoQualityState(), tier: 1, cooldownSamples: 30 }
    for (let serial = 1n; serial <= 30n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 42,
        frameBudgetMs: 40,
        frameSerial: serial,
        expectedFrameStep: 1n,
        backpressureCount: 0,
      })
    }
    expect(state.tier).toBe(1)
    expect(state.overloadSamples).toBe(0)
    for (let serial = 31n; serial <= 38n; serial++) {
      state = updateAdaptiveVideoQuality(state, {
        updateTimeMs: 42,
        frameBudgetMs: 40,
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

describe("VideoRenderable playback (integration)", () => {
  const VIDEO_FIXTURE = fileURLToPath(new URL("./fixtures/video/dragon.mp4", import.meta.url))

  async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (condition()) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return condition()
  }

  function countImageCells(renderer: TestRenderer): number {
    const chars = renderer.currentRenderBuffer.buffers.char
    let count = 0
    for (let index = 0; index < chars.length; index++) {
      if (chars[index] >>> 30 === 1) count++
    }
    return count
  }

  test("decodes real video and renders image placement cells", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 24, height: 10 })
    const ready = mock(() => {})
    const failed = mock(() => {})
    const video = new VideoRenderable(renderer, {
      source: VIDEO_FIXTURE,
      width: 24,
      height: 10,
      muted: true,
      onReady: ready,
      onError: failed,
    })
    renderer.root.add(video)
    try {
      await renderOnce()
      expect(failed).not.toHaveBeenCalled()
      expect(ready).toHaveBeenCalledTimes(1)
      expect(video.ready).toBe(true)
      expect(video.videoMetadata?.width).toBe(768)
      expect(video.videoMetadata?.height).toBe(1168)
      expect(video.videoMetadata?.fps).toBe(24)
      expect(video.videoMetadata?.hasAudio).toBe(true)
      expect(video.duration).toBeGreaterThan(5)
      expect(countImageCells(renderer)).toBeGreaterThan(0)
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })

  test("fires onEnd and stops once playback reaches the end", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 16, height: 8 })
    const ended = mock(() => {})
    const failed = mock(() => {})
    const video = new VideoRenderable(renderer, {
      source: VIDEO_FIXTURE,
      width: 16,
      height: 8,
      muted: true,
      onEnd: ended,
      onError: failed,
    })
    renderer.root.add(video)
    try {
      await renderOnce()
      video.seek(video.duration - 0.25)
      video.play()
      expect(video.playing).toBe(true)
      const finished = await waitFor(() => ended.mock.calls.length > 0, 8000)
      expect(failed).not.toHaveBeenCalled()
      expect(finished).toBe(true)
      expect(ended).toHaveBeenCalledTimes(1)
      expect(video.ended).toBe(true)
      expect(video.playing).toBe(false)
      expect(video.paused).toBe(true)
      expect(video.currentTime).toBeCloseTo(video.duration, 1)
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })

  test("loops seamlessly instead of ending when loop is enabled", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 16, height: 8 })
    const ended = mock(() => {})
    const failed = mock(() => {})
    const times: number[] = []
    const video = new VideoRenderable(renderer, {
      source: VIDEO_FIXTURE,
      width: 16,
      height: 8,
      muted: true,
      loop: true,
      onEnd: ended,
      onError: failed,
      onTimeUpdate: (time) => times.push(time),
    })
    renderer.root.add(video)
    try {
      await renderOnce()
      video.seek(video.duration - 0.25)
      video.play()
      const wrapped = await waitFor(() => times.some((time) => time < 1), 8000)
      expect(failed).not.toHaveBeenCalled()
      expect(wrapped).toBe(true)
      expect(ended).not.toHaveBeenCalled()
      expect(video.playing).toBe(true)
      expect(video.ended).toBe(false)
      video.pause()
      expect(video.paused).toBe(true)
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })

  test("seeking while playing continues from the target position", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 16, height: 8 })
    const failed = mock(() => {})
    const seeks: number[] = []
    const video = new VideoRenderable(renderer, {
      source: VIDEO_FIXTURE,
      width: 16,
      height: 8,
      muted: true,
      onError: failed,
      onSeek: (time) => seeks.push(time),
    })
    renderer.root.add(video)
    try {
      await renderOnce()
      video.play()
      await waitFor(() => video.currentTime > 0.05, 4000)
      video.seek(3)
      expect(seeks).toEqual([3])
      expect(video.currentTime).toBeGreaterThanOrEqual(2.9)
      const advanced = await waitFor(() => video.currentTime > 3.05, 4000)
      expect(failed).not.toHaveBeenCalled()
      expect(advanced).toBe(true)
      expect(video.currentTime).toBeLessThan(video.duration)
      expect(video.playing).toBe(true)
      video.pause()
      const positionAfterPause = video.currentTime
      expect(positionAfterPause).toBeGreaterThanOrEqual(3)
      await new Promise((resolve) => setTimeout(resolve, 120))
      expect(video.currentTime).toBeCloseTo(positionAfterPause, 2)
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })

  test("pausing and resuming preserves the playback position", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 16, height: 8 })
    const played = mock(() => {})
    const paused = mock(() => {})
    const video = new VideoRenderable(renderer, {
      source: VIDEO_FIXTURE,
      width: 16,
      height: 8,
      muted: true,
      onPlay: played,
      onPause: paused,
    })
    renderer.root.add(video)
    try {
      await renderOnce()
      video.play()
      expect(played).toHaveBeenCalledTimes(1)
      await waitFor(() => video.currentTime > 0.05, 4000)
      video.pause()
      expect(paused).toHaveBeenCalledTimes(1)
      const position = video.currentTime
      expect(position).toBeGreaterThan(0)
      video.play()
      expect(played).toHaveBeenCalledTimes(2)
      const advanced = await waitFor(() => video.currentTime > position + 0.05, 4000)
      expect(advanced).toBe(true)
      video.pause()
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })
})

describe("VideoRenderable mutable properties", () => {
  const VIDEO_FIXTURE = fileURLToPath(new URL("./fixtures/video/dragon.mp4", import.meta.url))

  test("swapping the source replaces the media", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 16, height: 8 })
    const video = new VideoRenderable(renderer, {
      source: "/nonexistent/opentui-missing.mp4",
      width: 16,
      height: 8,
      muted: true,
    })
    const errors: string[] = []
    video.onError = (error) => errors.push(error.message)
    const readies: number[] = []
    video.onReady = (metadata) => readies.push(metadata.duration)
    renderer.root.add(video)
    try {
      await renderOnce()
      expect(errors.length).toBe(1)
      expect(errors[0]).toMatch(/no such file/i)
      expect(video.ready).toBe(false)

      video.source = VIDEO_FIXTURE
      expect(video.source).toBe(VIDEO_FIXTURE)
      await renderOnce()
      expect(video.ready).toBe(true)
      expect(readies.length).toBe(1)
      expect(video.videoMetadata?.width).toBe(768)
      expect(video.currentTime).toBe(0)

      // Swapping away tears the old media down immediately.
      video.seek(2)
      video.source = "/nonexistent/opentui-other.mp4"
      expect(video.ready).toBe(false)
      expect(video.currentTime).toBe(0)
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })

  test("loop and maxFps are mutable after construction", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 16, height: 8 })
    const video = new VideoRenderable(renderer, {
      source: VIDEO_FIXTURE,
      width: 16,
      height: 8,
      muted: true,
    })
    renderer.root.add(video)
    try {
      await renderOnce()
      expect(video.loop).toBe(false)
      video.loop = true
      expect(video.loop).toBe(true)

      expect(video.maxFps).toBe(30)
      video.play()
      video.maxFps = 10
      expect(video.maxFps).toBe(10)
      expect(() => {
        video.maxFps = 0
      }).toThrow(RangeError)
      const advanced = await new Promise<boolean>((resolve) => {
        const deadline = Date.now() + 4000
        const poll = () => {
          if (video.currentTime > 0.05) return resolve(true)
          if (Date.now() > deadline) return resolve(false)
          setTimeout(poll, 25)
        }
        poll()
      })
      expect(advanced).toBe(true)
      video.pause()
    } finally {
      video.destroy()
      renderer.destroy()
    }
  })
})
