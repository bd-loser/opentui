import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"

import { Audio } from "../audio.js"
import type { OptimizedBuffer } from "../buffer.js"
import { NativeImage } from "../image.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import type { ImageRenderProtocol, RenderContext } from "../types.js"
import type { ImageFit } from "./Image.js"

export interface VideoMetadata {
  videoStreamIndex: number
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
}

export interface VideoRenderableOptions extends RenderableOptions<VideoRenderable> {
  source: string
  fit?: ImageFit
  protocol?: ImageRenderProtocol
  autoplay?: boolean
  loop?: boolean
  maxFps?: number
  ffmpegPath?: string
  ffprobePath?: string
  onReady?: (metadata: VideoMetadata) => void
  onError?: (error: Error) => void
  onEnd?: () => void
}

type SpawnProcess = typeof spawn

interface QueuedFrame {
  index: number
  pixels: Uint8Array
}

export interface VideoOutputGeometry {
  cellWidth: number
  cellHeight: number
  pixelWidth: number
  pixelHeight: number
  filter: string
}

export interface VideoGeometryOptions {
  fit: ImageFit
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
  terminalWidth: number
  terminalHeight: number
  resolution: { width: number; height: number } | null
}

const AUDIO_SAMPLE_RATE = 48_000
const AUDIO_CHANNELS = 2
const AUDIO_CAPACITY_FRAMES = 24_000
const AUDIO_PREBUFFER_FRAMES = 12_000
const MAX_VIDEO_QUEUE = 12

function parseRate(value: unknown): number {
  if (typeof value !== "string") return 0
  const [numerator, denominator = "1"] = value.split("/")
  const result = Number(numerator) / Number(denominator)
  return Number.isFinite(result) && result > 0 ? result : 0
}

export function parseVideoMetadata(value: string): VideoMetadata {
  const parsed = JSON.parse(value) as {
    streams?: Array<{
      index?: number
      codec_type?: string
      width?: number
      height?: number
      avg_frame_rate?: string
      r_frame_rate?: string
      duration?: string
      disposition?: { attached_pic?: number }
    }>
    format?: { duration?: string }
  }
  const streams = parsed.streams ?? []
  const video = streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1)
  if (!video || !video.width || !video.height) throw new Error("No playable video stream found")
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate)
  if (fps === 0) throw new Error("Video frame rate is unavailable")
  const duration = Number(video.duration ?? parsed.format?.duration ?? 0)
  return {
    videoStreamIndex: video.index ?? streams.indexOf(video),
    width: video.width,
    height: video.height,
    fps,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  }
}

export function buildFfmpegArgs(
  source: string,
  geometry: Pick<VideoOutputGeometry, "filter">,
  fps: number,
  metadata: Pick<VideoMetadata, "hasAudio" | "videoStreamIndex">,
): string[] {
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-re",
    "-i",
    source,
    "-map",
    `0:${metadata.videoStreamIndex}`,
    "-an",
    "-vf",
    `fps=${fps}:start_time=0,${geometry.filter}`,
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    "pipe:3",
  ]
  if (metadata.hasAudio) {
    args.push(
      "-map",
      "0:a:0",
      "-vn",
      "-af",
      `aresample=${AUDIO_SAMPLE_RATE}:async=1:first_pts=0`,
      "-ac",
      String(AUDIO_CHANNELS),
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-f",
      "f32le",
      "pipe:4",
    )
  }
  return args
}

export function calculateVideoGeometry(options: VideoGeometryOptions): VideoOutputGeometry {
  const { fit, sourceWidth, sourceHeight, targetWidth, targetHeight, terminalWidth, terminalHeight, resolution } =
    options
  const cellAspect =
    resolution && terminalWidth > 0 && terminalHeight > 0
      ? resolution.height / terminalHeight / (resolution.width / terminalWidth)
      : 2
  let cellWidth = targetWidth
  let cellHeight = targetHeight
  if (fit === "fit") {
    const displayAspect = (sourceWidth / sourceHeight) * cellAspect
    const scale = Math.min(targetWidth / displayAspect, targetHeight)
    cellWidth = Math.max(1, Math.round(displayAspect * scale))
    cellHeight = Math.max(1, Math.round(scale))
  }
  const pixelWidth =
    resolution && terminalWidth > 0
      ? Math.max(1, Math.round((cellWidth * resolution.width) / terminalWidth))
      : Math.max(1, cellWidth * 2)
  const pixelHeight =
    resolution && terminalHeight > 0
      ? Math.max(1, Math.round((cellHeight * resolution.height) / terminalHeight))
      : Math.max(1, cellHeight * 4)
  const scale = `scale=${pixelWidth}:${pixelHeight}:flags=lanczos`
  const filter =
    fit === "cover"
      ? `scale=${pixelWidth}:${pixelHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${pixelWidth}:${pixelHeight}`
      : scale
  return { cellWidth, cellHeight, pixelWidth, pixelHeight, filter }
}

async function probeVideo(
  source: string,
  ffprobePath: string,
  spawnProcess: SpawnProcess,
  onSpawn: (child: ChildProcess) => void,
): Promise<VideoMetadata> {
  const child = spawnProcess(ffprobePath, ["-v", "error", "-show_streams", "-show_format", "-of", "json", source], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  })
  onSpawn(child)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  if (code !== 0) throw new Error(`ffprobe failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString().trim()}`)
  return parseVideoMetadata(Buffer.concat(stdout).toString())
}

export class VideoRenderable extends Renderable {
  private readonly source: string
  private readonly ffmpegPath: string
  private readonly ffprobePath: string
  private readonly loopPlayback: boolean
  private readonly maxFps: number
  private readonly onReady?: (metadata: VideoMetadata) => void
  private readonly onError?: (error: Error) => void
  private readonly onEnd?: () => void
  private readonly spawnProcess: SpawnProcess
  private fitMode: ImageFit
  private renderProtocol: ImageRenderProtocol
  private metadata: VideoMetadata | null = null
  private probeProcess: ChildProcess | null = null
  private process: ChildProcess | null = null
  private audio: Audio | null = null
  private audioStream: Readable | null = null
  private audioPending = new Uint8Array(0)
  private audioPumpTimer: ReturnType<typeof setInterval> | null = null
  private audioClock = false
  private audioOutputEnded = false
  private wallClock = false
  private wallClockOffsetSeconds = 0
  private playbackStartedAt = 0
  private videoChunks: Uint8Array[] = []
  private videoChunkBytes = 0
  private frames: QueuedFrame[] = []
  private decodedFrameIndex = 0
  private currentImage: NativeImage | null = null
  private geometry: VideoOutputGeometry | null = null
  private configurationKey = ""
  private generation = 0
  private ticker: ReturnType<typeof setInterval> | null = null
  private wantsPlayback: boolean
  private starting = false
  private ended = false
  private diagnostics = ""

  constructor(ctx: RenderContext, options: VideoRenderableOptions) {
    super(ctx, options)
    this.source = options.source
    this.fitMode = options.fit ?? "fit"
    this.renderProtocol = options.protocol ?? "auto"
    this.loopPlayback = options.loop ?? false
    const maxFps = options.maxFps ?? 30
    if (!Number.isFinite(maxFps) || maxFps <= 0) throw new RangeError("maxFps must be a positive finite number")
    this.maxFps = maxFps
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg"
    this.ffprobePath = options.ffprobePath ?? "ffprobe"
    this.onReady = options.onReady
    this.onError = options.onError
    this.onEnd = options.onEnd
    this.spawnProcess = spawn
    this.wantsPlayback = options.autoplay ?? false
  }

  public get fit(): ImageFit {
    return this.fitMode
  }

  public set fit(value: ImageFit) {
    if (this.fitMode === value) return
    this.fitMode = value
    this.configurationKey = ""
    this.requestRender()
  }

  public get protocol(): ImageRenderProtocol {
    return this.renderProtocol
  }

  public set protocol(value: ImageRenderProtocol) {
    if (this.renderProtocol === value) return
    this.renderProtocol = value
    this.requestRender()
  }

  public get playing(): boolean {
    return this.wantsPlayback && this.process !== null && !this.ended
  }

  public play(): void {
    if (this.wantsPlayback && !this.ended) return
    this.wantsPlayback = true
    this.ended = false
    this.requestRender()
  }

  public pause(): void {
    this.wantsPlayback = false
    this.stopPlayback(false)
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this.width <= 0 || this.height <= 0) return
    if (this.wantsPlayback) void this.ensurePlayback()
    if (!this.currentImage || !this.geometry) return

    const x = (this.buffered ? 0 : this._screenX) + Math.floor((this.width - this.geometry.cellWidth) / 2)
    const y = (this.buffered ? 0 : this._screenY) + Math.floor((this.height - this.geometry.cellHeight) / 2)
    buffer.drawImage(
      this.currentImage,
      x,
      y,
      this.geometry.cellWidth,
      this.geometry.cellHeight,
      this.geometry.pixelWidth,
      this.geometry.pixelHeight,
      0,
      0,
      this.currentImage.width,
      this.currentImage.height,
      this.renderProtocol,
    )
  }

  private calculateGeometry(metadata: VideoMetadata): VideoOutputGeometry {
    return calculateVideoGeometry({
      fit: this.fitMode,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
      targetWidth: this.width,
      targetHeight: this.height,
      terminalWidth: this._ctx.terminalWidth,
      terminalHeight: this._ctx.terminalHeight,
      resolution: this._ctx.terminalWidth > 0 && this._ctx.terminalHeight > 0 ? this._ctx.resolution : null,
    })
  }

  private async ensurePlayback(): Promise<void> {
    if (this.starting || this.isDestroyed || !this.wantsPlayback) return
    this.starting = true
    const generation = this.generation
    try {
      const metadata =
        this.metadata ??
        (await probeVideo(this.source, this.ffprobePath, this.spawnProcess, (child) => {
          if (generation === this.generation) this.probeProcess = child
        }))
      this.probeProcess = null
      if (this.isDestroyed || !this.wantsPlayback || generation !== this.generation) return
      if (!this.metadata) {
        this.metadata = metadata
        this.onReady?.(metadata)
      }
      const geometry = this.calculateGeometry(metadata)
      const fps = Math.min(metadata.fps, this.maxFps)
      const key = `${geometry.pixelWidth}x${geometry.pixelHeight}:${this.fitMode}:${fps}`
      if (this.process && key === this.configurationKey) return
      this.stopPlayback(false)
      if (!this.wantsPlayback || this.isDestroyed) return
      this.configurationKey = key
      this.geometry = geometry
      this.startProcess(metadata, geometry, fps)
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed || !this.wantsPlayback) return
      this.stopPlayback(false)
      this.reportError(error)
      this.wantsPlayback = false
    } finally {
      this.starting = false
    }
  }

  private startProcess(metadata: VideoMetadata, geometry: VideoOutputGeometry, fps: number): void {
    const generation = this.generation
    const child = this.spawnProcess(this.ffmpegPath, buildFfmpegArgs(this.source, geometry, fps, metadata), {
      shell: false,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    })
    this.process = child
    this.ended = false
    this.wallClock = !metadata.hasAudio
    this.wallClockOffsetSeconds = 0
    this.audioOutputEnded = !metadata.hasAudio
    this.playbackStartedAt = performance.now()
    this.startTicker(fps)

    const video = child.stdio[3] as Readable | null
    const audio = child.stdio[4] as Readable | null
    if (!video) throw new Error("FFmpeg video pipe was not created")
    video.on("data", (chunk: Buffer) => {
      if (generation === this.generation && child === this.process) {
        this.acceptVideoBytes(chunk, geometry.pixelWidth * geometry.pixelHeight * 4)
      }
    })
    video.on("error", (error) => {
      if (generation === this.generation) this.reportError(error)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (generation === this.generation) this.diagnostics = (this.diagnostics + chunk.toString()).slice(-8192)
    })
    child.once("error", (error) => {
      if (generation === this.generation) this.reportError(error)
    })
    child.once("close", (code, signal) => {
      if (generation !== this.generation || child !== this.process) return
      this.process = null
      if (code !== 0) {
        this.reportError(new Error(`ffmpeg failed (${code ?? signal ?? "signal"}): ${this.diagnostics.trim()}`))
        this.wantsPlayback = false
        return
      }
      this.ended = true
    })

    if (metadata.hasAudio && audio) this.startAudio(audio, generation)
    else if (metadata.hasAudio) {
      this.wallClock = true
      this.playbackStartedAt = performance.now()
    }
  }

  private acceptVideoBytes(chunk: Uint8Array, frameBytes: number): void {
    this.videoChunks.push(chunk)
    this.videoChunkBytes += chunk.byteLength
    while (this.videoChunkBytes >= frameBytes) {
      const pixels = new Uint8Array(frameBytes)
      let offset = 0
      while (offset < frameBytes) {
        const first = this.videoChunks[0]
        const count = Math.min(first.byteLength, frameBytes - offset)
        pixels.set(first.subarray(0, count), offset)
        offset += count
        this.videoChunkBytes -= count
        if (count === first.byteLength) this.videoChunks.shift()
        else this.videoChunks[0] = first.subarray(count)
      }
      const frame = { index: this.decodedFrameIndex++, pixels }
      const desired = this.desiredFrameIndex()
      if (this.frames.length < MAX_VIDEO_QUEUE) this.frames.push(frame)
      else if (this.frames[0].index <= desired) {
        this.frames.shift()
        this.frames.push(frame)
      }
      if (frame.index === 0) this.presentDueFrame()
    }
  }

  private startAudio(stream: Readable, generation: number): void {
    const audio = Audio.create({ autoStart: false, sampleRate: AUDIO_SAMPLE_RATE, playbackChannels: AUDIO_CHANNELS })
    audio.on("error", () => {})
    if (!audio.enablePcmStream(AUDIO_CAPACITY_FRAMES, AUDIO_CHANNELS)) {
      audio.dispose()
      this.wallClock = true
      this.playbackStartedAt = performance.now()
      stream.resume()
      return
    }
    this.audio = audio
    this.audioStream = stream
    stream.on("data", (chunk: Buffer) => {
      if (generation === this.generation) this.acceptAudioBytes(chunk)
    })
    stream.on("error", (error) => {
      if (generation === this.generation) this.reportError(error)
    })
    stream.on("end", () => {
      if (generation !== this.generation) return
      this.audioOutputEnded = true
      this.maybeStartAudio(true)
    })
    this.audioPumpTimer = setInterval(() => this.pumpAudio(), 5)
  }

  private acceptAudioBytes(chunk: Uint8Array): void {
    if (!this.audio) return
    const merged = new Uint8Array(this.audioPending.byteLength + chunk.byteLength)
    merged.set(this.audioPending)
    merged.set(chunk, this.audioPending.byteLength)
    this.audioPending = merged
    this.pumpAudio()
  }

  private pumpAudio(): void {
    const audio = this.audio
    if (!audio || this.audioPending.byteLength < AUDIO_CHANNELS * 4) return
    const completeBytes = this.audioPending.byteLength - (this.audioPending.byteLength % (AUDIO_CHANNELS * 4))
    const copy = this.audioPending.slice(0, completeBytes)
    const written = audio.writePcm(new Float32Array(copy.buffer))
    if (written == null) return
    const consumedBytes = written * AUDIO_CHANNELS * 4
    this.audioPending = this.audioPending.slice(consumedBytes)
    if (this.audioPending.byteLength >= AUDIO_CHANNELS * 4) this.audioStream?.pause()
    else this.audioStream?.resume()

    this.maybeStartAudio(false)
  }

  private maybeStartAudio(endOfStream: boolean): void {
    const audio = this.audio
    if (!audio || this.audioClock || this.wallClock) return
    const queued = audio.getPcmQueuedFrames()
    if (queued < AUDIO_PREBUFFER_FRAMES && !(endOfStream && queued > 0)) return
    if (audio.start()) {
      this.audioClock = true
      return
    }
    audio.disablePcmStream()
    this.wallClock = true
    this.playbackStartedAt = performance.now()
    this.audioPending = new Uint8Array(0)
    this.audioStream?.resume()
  }

  private startTicker(fps: number): void {
    this.ticker = setInterval(
      () => {
        this.presentDueFrame()
        if (
          this.audioClock &&
          this.audioOutputEnded &&
          (this.audio?.getPcmQueuedFrames() ?? 0) === 0 &&
          this.audioPending.byteLength < AUDIO_CHANNELS * 4
        ) {
          this.wallClockOffsetSeconds = Number(this.audio?.getPcmConsumedFrames() ?? 0n) / AUDIO_SAMPLE_RATE
          this.audioClock = false
          this.wallClock = true
          this.playbackStartedAt = performance.now()
        }
        if (!this.ended) return
        const drained = this.audioClock
          ? (this.audio?.getPcmQueuedFrames() ?? 0) === 0 && this.audioPending.byteLength < AUDIO_CHANNELS * 4
          : this.frames.length === 0
        if (!drained) return
        if (this.loopPlayback && this.wantsPlayback) {
          this.configurationKey = ""
          this.stopPlayback(false)
          this.requestRender()
        } else {
          this.wantsPlayback = false
          this.stopTicker()
          this.onEnd?.()
        }
      },
      Math.max(4, Math.floor(1000 / fps / 2)),
    )
  }

  private desiredFrameIndex(): number {
    const fps = Math.min(this.metadata?.fps ?? this.maxFps, this.maxFps)
    const seconds =
      this.audioClock && this.audio
        ? Number(this.audio.getPcmConsumedFrames()) / AUDIO_SAMPLE_RATE
        : this.wallClock
          ? this.wallClockOffsetSeconds + Math.max(0, performance.now() - this.playbackStartedAt) / 1000
          : 0
    return Math.floor(seconds * fps)
  }

  private presentDueFrame(): void {
    const desired = this.desiredFrameIndex()
    let selected: QueuedFrame | undefined
    while (this.frames.length > 0 && this.frames[0].index <= desired) selected = this.frames.shift()
    if (!selected || !this.geometry) return
    const next = NativeImage.fromRgba(selected.pixels, this.geometry.pixelWidth, this.geometry.pixelHeight)
    const previous = this.currentImage
    this.currentImage = next
    previous?.dispose()
    this.requestRender()
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  private stopPlayback(clearImage: boolean): void {
    this.generation++
    this.probeProcess?.kill("SIGTERM")
    this.probeProcess = null
    this.process?.kill("SIGTERM")
    this.process = null
    this.stopTicker()
    if (this.audioPumpTimer) clearInterval(this.audioPumpTimer)
    this.audioPumpTimer = null
    this.audioStream = null
    this.audio?.dispose()
    this.audio = null
    this.audioClock = false
    this.audioOutputEnded = false
    this.wallClock = false
    this.wallClockOffsetSeconds = 0
    this.audioPending = new Uint8Array(0)
    this.videoChunks = []
    this.videoChunkBytes = 0
    this.frames = []
    this.decodedFrameIndex = 0
    this.diagnostics = ""
    if (clearImage) {
      this.currentImage?.dispose()
      this.currentImage = null
      this.geometry = null
    }
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    this.onError?.(normalized)
  }

  protected destroySelf(): void {
    this.wantsPlayback = false
    this.stopPlayback(true)
    super.destroySelf()
  }
}
