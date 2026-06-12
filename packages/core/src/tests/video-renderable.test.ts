import { describe, expect, test } from "bun:test"

import { buildFfmpegArgs, calculateVideoGeometry, parseVideoMetadata } from "../renderables/Video.js"

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
})
