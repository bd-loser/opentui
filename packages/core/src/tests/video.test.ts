import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { NativeVideo } from "../video.js"

const VIDEO_FIXTURE = fileURLToPath(new URL("./fixtures/video/dragon.mp4", import.meta.url))
const PNG_FIXTURE = fileURLToPath(new URL("./fixtures/images/rgba.png", import.meta.url))

describe("NativeVideo", () => {
  test("reports media metadata for a real file", () => {
    const video = NativeVideo.open(VIDEO_FIXTURE)
    try {
      expect(video.info.width).toBeGreaterThan(0)
      expect(video.info.height).toBeGreaterThan(0)
      expect(video.info.duration).toBeGreaterThan(1)
      expect(video.info.fps).toBeGreaterThan(0)
      expect(video.info.hasAudio).toBe(true)
      expect(video.info.audioSampleRate).toBe(48000)
      expect(video.info.audioChannels).toBe(2)
    } finally {
      video.dispose()
    }
  })

  test("open failures carry the native error detail", () => {
    let message = ""
    try {
      NativeVideo.open(PNG_FIXTURE)
      throw new Error("expected open to fail for a non-video file")
    } catch (error) {
      message = (error as Error).message
    }
    // The failure reason from the demuxer/decoder must survive, not just a
    // bare status code.
    expect(message).toMatch(/Native video failed/)
    expect(message.length).toBeGreaterThan("Native video failed (3)".length)
    expect(message).toMatch(/avformat|codec|Invalid|moov|stream/i)
  })

  test("open failures for missing files carry the native error detail", () => {
    let message = ""
    try {
      NativeVideo.open("/nonexistent/opentui-missing.mp4")
      throw new Error("expected open to fail for a missing file")
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/no such file/i)
  })

  test("decodes frames and exposes them as native images", () => {
    const video = NativeVideo.open(VIDEO_FIXTURE)
    try {
      const state = video.update(0)
      expect(state.hasFrame).toBe(true)
      const frame = video.takeFrame()
      expect(frame).not.toBeNull()
      try {
        expect(frame!.width).toBe(video.info.width)
        expect(frame!.height).toBe(video.info.height)
        const raw = frame!.raw()
        expect(raw.data.length).toBe(video.info.width * video.info.height * 4)
        let nonZero = false
        for (let index = 0; index < raw.data.length; index += 4) {
          if (raw.data[index] !== 0 || raw.data[index + 1] !== 0 || raw.data[index + 2] !== 0) {
            nonZero = true
            break
          }
        }
        expect(nonZero).toBe(true)
      } finally {
        frame!.dispose()
      }
      // Same serial: no new frame is handed out until the video advances.
      expect(video.takeFrame()).toBeNull()
    } finally {
      video.dispose()
    }
  })

  test("readAudio requires the external audio open mode", () => {
    const video = NativeVideo.open(VIDEO_FIXTURE)
    try {
      expect(() => video.readAudio(new Float32Array(512))).toThrow(/externalAudio/)
    } finally {
      video.dispose()
    }
  })

  test("external audio mode reads decoded PCM manually", () => {
    const video = NativeVideo.open(VIDEO_FIXTURE, { externalAudio: true })
    try {
      expect(video.info.hasAudio).toBe(true)
      const buffer = new Float32Array(4096 * 2)
      const first = video.readAudio(buffer)
      expect(first).toBeGreaterThan(0)

      let hasSignal = false
      let total = first
      while (total < 96_000) {
        const frames = video.readAudio(buffer)
        if (frames === 0) break
        total += frames
        for (let index = 0; index < frames * 2; index++) {
          if (Math.abs(buffer[index]) > 0.01) {
            hasSignal = true
            break
          }
        }
        if (hasSignal) break
      }
      expect(hasSignal).toBe(true)
    } finally {
      video.dispose()
    }
  })

  test("external audio mode still plays video frames silently", () => {
    const video = NativeVideo.open(VIDEO_FIXTURE, { externalAudio: true })
    try {
      video.play()
      const state = video.update(0)
      expect(state.hasFrame).toBe(true)
      expect(state.playing).toBe(true)
      expect(state.audioActive).toBe(false)
      const frame = video.takeFrame()
      expect(frame).not.toBeNull()
      frame!.dispose()
    } finally {
      video.dispose()
    }
  })

  test("rejects invalid inputs without touching native state", () => {
    expect(() => NativeVideo.open("")).toThrow(TypeError)
    const video = NativeVideo.open(VIDEO_FIXTURE)
    video.dispose()
    expect(() => video.update(0)).toThrow(/disposed/)
    expect(() => video.dispose()).not.toThrow()
  })
})
