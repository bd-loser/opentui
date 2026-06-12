import { readFile } from "node:fs/promises"

import { describe, expect, test } from "bun:test"

import {
  buildFfmpegArgs,
  calculateVideoGeometry,
  normalizeVideoTime,
  parseVideoMetadata,
  PngStreamParser,
  releaseVideoProcess,
  VideoRenderable,
} from "../renderables/Video.js"
import { createTestRenderer } from "../testing.js"

const PNG_FIXTURE = new URL("./fixtures/images/rgba.png", import.meta.url)

describe("VideoRenderable FFmpeg contract", () => {
  test("selects the playable video stream instead of attached cover art", () => {
    const metadata = parseVideoMetadata(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: "video",
            width: 640,
            height: 480,
            disposition: { attached_pic: 1 },
            avg_frame_rate: "0/0",
          },
          {
            index: 2,
            codec_type: "video",
            width: 768,
            height: 1168,
            disposition: { attached_pic: 0 },
            avg_frame_rate: "24/1",
            duration: "6.04",
          },
          { codec_type: "audio" },
        ],
        format: { duration: "6.05" },
      }),
    )

    expect(metadata).toEqual({ videoStreamIndex: 2, width: 768, height: 1168, fps: 24, duration: 6.04, hasAudio: true })
  })

  test("builds one process with independent raw video and PCM pipes", () => {
    const args = buildFfmpegArgs("input with spaces.mp4", { filter: "scale=320:480:flags=lanczos" }, 24, {
      hasAudio: true,
      videoStreamIndex: 2,
    })
    expect(args).toContain("pipe:3")
    expect(args).toContain("pipe:4")
    expect(args).toContain("0:2")
    expect(args).toContain("0:a:0")
    expect(args).toContain("f32le")
    expect(args).toContain("image2pipe")
    expect(args).toContain("png")
    expect(args[args.indexOf("-vf") + 1]).toContain("format=pal8")
    expect(args).not.toContain("rawvideo")
    expect(args).toContain("input with spaces.mp4")
    expect(args).not.toContain("input")
  })

  test("omits the audio output for silent media", () => {
    const args = buildFfmpegArgs("silent.mp4", { filter: "scale=320:480" }, 24, {
      hasAudio: false,
      videoStreamIndex: 0,
    })
    expect(args).toContain("pipe:3")
    expect(args).not.toContain("pipe:4")
    expect(args).not.toContain("0:a:0")
  })

  test("omits audio decoding and output when muted", () => {
    const args = buildFfmpegArgs(
      "muted.mp4",
      { filter: "scale=320:480" },
      24,
      { hasAudio: true, videoStreamIndex: 0 },
      false,
      true,
    )
    expect(args).toContain("pipe:3")
    expect(args).not.toContain("pipe:4")
    expect(args).not.toContain("0:a:0")
    expect(args).not.toContain("f32le")
  })

  test("loops through one FFmpeg input timeline without respawning", () => {
    const args = buildFfmpegArgs(
      "loop.mp4",
      { filter: "scale=320:480" },
      24,
      { hasAudio: true, videoStreamIndex: 0 },
      true,
    )
    const loopIndex = args.indexOf("-stream_loop")
    expect(loopIndex).toBeGreaterThan(-1)
    expect(args[loopIndex + 1]).toBe("-1")
    expect(loopIndex).toBeLessThan(args.indexOf("-i"))
  })

  test("places fractional seek before the input without rounding", () => {
    const args = buildFfmpegArgs(
      "seek.mp4",
      { filter: "scale=320:480" },
      24,
      { hasAudio: true, videoStreamIndex: 0 },
      true,
      false,
      1.375,
    )
    const seekIndex = args.indexOf("-ss")
    expect(seekIndex).toBeGreaterThan(-1)
    expect(args[seekIndex + 1]).toBe("1.375")
    expect(seekIndex).toBeLessThan(args.indexOf("-i"))
    expect(args.indexOf("-re")).toBeLessThan(args.indexOf("-i"))
  })

  test("builds paused seek previews without realtime throttling or audio", () => {
    const args = buildFfmpegArgs(
      "preview.mp4",
      { filter: "scale=320:480" },
      24,
      { hasAudio: true, videoStreamIndex: 0 },
      true,
      false,
      2.125,
      true,
    )
    expect(args).not.toContain("-re")
    expect(args).not.toContain("-stream_loop")
    expect(args).not.toContain("0:a:0")
    expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2)).toEqual(["-frames:v", "1"])
    expect(args[args.indexOf("-ss") + 1]).toBe("2.125")
  })

  test("rejects metadata without a usable frame rate", () => {
    expect(() =>
      parseVideoMetadata(
        JSON.stringify({
          streams: [{ codec_type: "video", width: 10, height: 10, avg_frame_rate: "0/0" }],
        }),
      ),
    ).toThrow("frame rate")
  })

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
    expect(geometry.cellWidth).toBe(24)
    expect(geometry.cellHeight).toBe(18)
    expect(geometry.pixelWidth).toBe(48)
    expect(geometry.pixelHeight).toBe(72)
    expect(geometry.filter).toBe("scale=48:72:flags=lanczos")
  })

  test("cover fills the destination and asks FFmpeg to crop", () => {
    const geometry = calculateVideoGeometry({
      fit: "cover",
      sourceWidth: 768,
      sourceHeight: 1168,
      targetWidth: 80,
      targetHeight: 18,
      terminalWidth: 80,
      terminalHeight: 24,
      resolution: null,
    })
    expect(geometry).toEqual({
      cellWidth: 80,
      cellHeight: 18,
      pixelWidth: 160,
      pixelHeight: 72,
      filter: "scale=160:72:force_original_aspect_ratio=increase:flags=lanczos,crop=160:72",
    })
  })

  test("uses measured terminal pixels for cover and fill", () => {
    const base = {
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 40,
      targetHeight: 10,
      terminalWidth: 100,
      terminalHeight: 30,
      resolution: { width: 1000, height: 600 },
    }
    const cover = calculateVideoGeometry({ ...base, fit: "cover" })
    const fill = calculateVideoGeometry({ ...base, fit: "fill" })
    expect(cover.pixelWidth).toBe(400)
    expect(cover.pixelHeight).toBe(200)
    expect(cover.filter).toContain("force_original_aspect_ratio=increase")
    expect(cover.filter).toContain("crop=400:200")
    expect(fill).toEqual({
      cellWidth: 40,
      cellHeight: 10,
      pixelWidth: 400,
      pixelHeight: 200,
      filter: "scale=400:200:flags=lanczos",
    })
  })

  test("terminates and unreferences decoder processes and every pipe", () => {
    const destroyed: boolean[] = []
    let killedWith: NodeJS.Signals | number | undefined
    let unreferenced = false
    const child = {
      exitCode: null,
      signalCode: null,
      stdio: Array.from({ length: 5 }, () => ({ destroy: () => destroyed.push(true) })),
      kill: (signal?: NodeJS.Signals | number) => {
        killedWith = signal
        return true
      },
      unref: () => {
        unreferenced = true
      },
    }

    releaseVideoProcess(child as never)

    expect(killedWith).toBe("SIGTERM")
    expect(destroyed).toHaveLength(5)
    expect(unreferenced).toBe(true)
  })
})

test("PNG stream parser handles split and consecutive frames", async () => {
  const png = new Uint8Array(await readFile(PNG_FIXTURE))
  const input = new Uint8Array(png.byteLength * 2)
  input.set(png)
  input.set(png, png.byteLength)
  const frames: Uint8Array[] = []
  const parser = new PngStreamParser((frame) => frames.push(frame))

  parser.push(input.subarray(0, png.byteLength + 7))
  parser.push(input.subarray(png.byteLength + 7))
  parser.finish()

  expect(frames).toEqual([png, png])
})

describe("VideoRenderable timeline", () => {
  test("normalizes clamped and looped subsecond positions", () => {
    expect(normalizeVideoTime(1.375, 6.04, false)).toBe(1.375)
    expect(normalizeVideoTime(9, 6.04, false)).toBe(6.04)
    expect(normalizeVideoTime(-0.25, 6.04, false)).toBe(0)
    expect(normalizeVideoTime(7.29, 6.04, true)).toBeCloseTo(1.25, 12)
    expect(normalizeVideoTime(6.04, 6.04, true)).toBeCloseTo(0, 12)
    expect(normalizeVideoTime(3.125, 0, false)).toBe(3.125)
    expect(() => normalizeVideoTime(Number.NaN, 1, false)).toThrow("finite")
    expect(() => normalizeVideoTime(Number.POSITIVE_INFINITY, 1, false)).toThrow("finite")
  })

  test("exposes precise paused position and play intent", async () => {
    const setup = await createTestRenderer({ width: 20, height: 10 })
    const seeks: number[] = []
    const updates: number[] = []
    const video = new VideoRenderable(setup.renderer, {
      source: "unused.mp4",
      autoplay: false,
      onSeek: (time) => seeks.push(time),
      onTimeUpdate: (time) => updates.push(time),
    })
    setup.renderer.root.add(video)

    try {
      expect(video.duration).toBe(0)
      expect(video.durationMs).toBe(0)
      expect(video.ready).toBe(false)
      expect(video.videoMetadata).toBeNull()
      expect(video.currentTime).toBe(0)
      expect(video.paused).toBe(true)
      expect(video.playing).toBe(false)
      expect(video.ended).toBe(false)

      video.seek(1.375)
      expect(video.currentTime).toBe(1.375)
      expect(video.currentTimeMs).toBe(1375)
      video.seekBy(0.125)
      expect(video.currentTime).toBe(1.5)
      video.seekToMs(1625.5)
      expect(video.currentTime).toBe(1.6255)
      expect(seeks).toEqual([1.375, 1.5, 1.6255])
      expect(updates).toEqual(seeks)

      video.play()
      expect(video.playing).toBe(true)
      expect(video.paused).toBe(false)
      video.pause()
      expect(video.currentTime).toBe(1.6255)
      expect(video.playing).toBe(false)
      expect(video.paused).toBe(true)
      video.resume()
      expect(video.playing).toBe(true)
      video.pause()
      expect(() => video.seek(Number.NaN)).toThrow("finite")
      expect(() => video.seekBy(Number.POSITIVE_INFINITY)).toThrow("finite")
    } finally {
      video.destroyRecursively()
      setup.renderer.destroy()
    }
  })
})
