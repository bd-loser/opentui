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
  muted?: boolean
  maxFps?: number
  ffmpegPath?: string
  ffprobePath?: string
  onReady?: (metadata: VideoMetadata) => void
  onError?: (error: Error) => void
  onEnd?: () => void
  onPlay?: () => void
  onPause?: () => void
  onSeek?: (time: number) => void
  onTimeUpdate?: (time: number) => void
}

type SpawnProcess = typeof spawn

interface QueuedFrame {
  index: number
  image: NativeImage
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
const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)
const MAX_PNG_FRAME_BYTES = 64 * 1024 * 1024

export class PngStreamParser {
  private buffer = new Uint8Array(0)

  constructor(
    private readonly onFrame: (png: Uint8Array) => void,
    private readonly maxFrameBytes = MAX_PNG_FRAME_BYTES,
  ) {}

  public push(input: Uint8Array): void {
    const combined = new Uint8Array(this.buffer.byteLength + input.byteLength)
    combined.set(this.buffer)
    combined.set(input, this.buffer.byteLength)
    this.buffer = combined

    while (this.buffer.byteLength >= PNG_SIGNATURE.byteLength) {
      if (!PNG_SIGNATURE.every((byte, index) => this.buffer[index] === byte)) {
        this.reset()
        throw new Error("Invalid PNG signature in FFmpeg output")
      }
      let offset = PNG_SIGNATURE.byteLength
      let complete = false
      while (this.buffer.byteLength >= offset + 8) {
        const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4).getUint32(0, false)
        const chunkBytes = length + 12
        if (chunkBytes > this.maxFrameBytes - offset) {
          this.reset()
          throw new Error(`PNG frame exceeds ${this.maxFrameBytes} bytes`)
        }
        if (this.buffer.byteLength < offset + chunkBytes) break
        const isIend = String.fromCharCode(...this.buffer.subarray(offset + 4, offset + 8)) === "IEND"
        offset += chunkBytes
        if (isIend) {
          const frame = this.buffer.slice(0, offset)
          this.buffer = this.buffer.slice(offset)
          this.onFrame(frame)
          complete = true
          break
        }
      }
      if (!complete) return
    }
  }

  public finish(): void {
    if (this.buffer.byteLength !== 0) throw new Error("Truncated PNG in FFmpeg output")
  }

  public reset(): void {
    this.buffer = new Uint8Array(0)
  }
}

function parseRate(value: unknown): number {
  if (typeof value !== "string") return 0
  const [numerator, denominator = "1"] = value.split("/")
  const result = Number(numerator) / Number(denominator)
  return Number.isFinite(result) && result > 0 ? result : 0
}

export function releaseVideoProcess(child: ChildProcess | null): void {
  if (!child) return
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  for (const stream of child.stdio) stream?.destroy()
  child.unref()
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
  loop: boolean = false,
  muted: boolean = false,
  startTime: number = 0,
  preview: boolean = false,
): string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"]
  if (!preview) args.push("-re")
  if (loop && !preview) args.push("-stream_loop", "-1")
  if (startTime > 0) args.push("-ss", String(startTime))
  args.push(
    "-i",
    source,
    "-map",
    `0:${metadata.videoStreamIndex}`,
    "-an",
    "-vf",
    `fps=${fps}:start_time=0,${geometry.filter},format=pal8`,
    "-c:v",
    "png",
    "-compression_level",
    "1",
    "-pred",
    "none",
    ...(preview ? ["-frames:v", "1"] : []),
    "-f",
    "image2pipe",
    "pipe:3",
  )
  if (metadata.hasAudio && !muted && !preview) {
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

export function normalizeVideoTime(value: number, duration: number, loop: boolean): number {
  if (!Number.isFinite(value)) throw new RangeError("Video time must be finite")
  const nonNegative = Math.max(0, value)
  if (!(duration > 0) || !Number.isFinite(duration)) return nonNegative
  if (!loop) return Math.min(nonNegative, duration)
  return ((nonNegative % duration) + duration) % duration
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
  private readonly onPlay?: () => void
  private readonly onPause?: () => void
  private readonly onSeek?: (time: number) => void
  private readonly onTimeUpdate?: (time: number) => void
  private readonly spawnProcess: SpawnProcess
  private fitMode: ImageFit
  private renderProtocol: ImageRenderProtocol
  private mutedPlayback: boolean
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
  private frames: QueuedFrame[] = []
  private decodedFrameIndex = 0
  private currentImage: NativeImage | null = null
  private geometry: VideoOutputGeometry | null = null
  private configurationKey = ""
  private generation = 0
  private ticker: ReturnType<typeof setInterval> | null = null
  private wantsPlayback: boolean
  private starting = false
  private decoderEnded = false
  private diagnostics = ""
  private positionSeconds = 0
  private processOriginSeconds = 0
  private playbackEnded = false
  private previewRequested = false

  constructor(ctx: RenderContext, options: VideoRenderableOptions) {
    super(ctx, options)
    this.source = options.source
    this.fitMode = options.fit ?? "fit"
    this.renderProtocol = options.protocol ?? "auto"
    this.loopPlayback = options.loop ?? false
    this.mutedPlayback = options.muted ?? false
    const maxFps = options.maxFps ?? 30
    if (!Number.isFinite(maxFps) || maxFps <= 0) throw new RangeError("maxFps must be a positive finite number")
    this.maxFps = maxFps
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg"
    this.ffprobePath = options.ffprobePath ?? "ffprobe"
    this.onReady = options.onReady
    this.onError = options.onError
    this.onEnd = options.onEnd
    this.onPlay = options.onPlay
    this.onPause = options.onPause
    this.onSeek = options.onSeek
    this.onTimeUpdate = options.onTimeUpdate
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
    return this.wantsPlayback && !this.playbackEnded
  }

  public get paused(): boolean {
    return !this.wantsPlayback
  }

  public get ended(): boolean {
    return this.playbackEnded
  }

  public get duration(): number {
    return this.metadata?.duration ?? 0
  }

  public get ready(): boolean {
    return this.metadata !== null
  }

  public get videoMetadata(): Readonly<VideoMetadata> | null {
    return this.metadata ? { ...this.metadata } : null
  }

  public get durationMs(): number {
    return this.duration * 1000
  }

  public get currentTime(): number {
    if (!this.wantsPlayback || (!this.audioClock && !this.wallClock)) return this.positionSeconds
    return normalizeVideoTime(this.processOriginSeconds + this.processElapsedTime(), this.duration, this.loopPlayback)
  }

  public set currentTime(value: number) {
    this.seek(value)
  }

  public get currentTimeMs(): number {
    return this.currentTime * 1000
  }

  public get muted(): boolean {
    return this.mutedPlayback
  }

  public set muted(value: boolean) {
    if (this.mutedPlayback === value) return
    this.mutedPlayback = value
    this.configurationKey = ""
    this.requestRender()
  }

  public play(): void {
    if (this.wantsPlayback && !this.playbackEnded) return
    if (this.previewRequested) {
      this.previewRequested = false
      this.stopPlayback(false)
    }
    if (this.playbackEnded && this.duration > 0 && this.positionSeconds >= this.duration) this.positionSeconds = 0
    this.wantsPlayback = true
    this.previewRequested = false
    this.playbackEnded = false
    this.decoderEnded = false
    this.requestRender()
    this.onPlay?.()
  }

  public pause(): void {
    if (!this.wantsPlayback && !this.previewRequested) return
    const wasPlaying = this.wantsPlayback
    if (wasPlaying) this.positionSeconds = this.currentTime
    this.wantsPlayback = false
    this.previewRequested = false
    this.stopPlayback(false)
    if (wasPlaying) {
      this.onPause?.()
      this.onTimeUpdate?.(this.positionSeconds)
    }
  }

  public resume(): void {
    this.play()
  }

  public toggle(): void {
    if (this.wantsPlayback) this.pause()
    else this.play()
  }

  public seek(time: number): void {
    const target = normalizeVideoTime(time, this.duration, this.loopPlayback)
    const resume = this.wantsPlayback
    this.positionSeconds = target
    this.playbackEnded = false
    this.stopPlayback(false)
    if (!this.loopPlayback && this.duration > 0 && target >= this.duration) {
      this.wantsPlayback = false
    } else {
      this.wantsPlayback = resume
      this.previewRequested = !resume
      this.requestRender()
    }
    this.onSeek?.(target)
    this.onTimeUpdate?.(target)
  }

  public seekBy(delta: number): void {
    if (!Number.isFinite(delta)) throw new RangeError("Video seek delta must be finite")
    this.seek(this.currentTime + delta)
  }

  public seekToMs(milliseconds: number): void {
    if (!Number.isFinite(milliseconds)) throw new RangeError("Video time must be finite")
    this.seek(milliseconds / 1000)
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (this.width <= 0 || this.height <= 0) return
    if (this.wantsPlayback || this.previewRequested) void this.ensurePlayback()
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
    if (this.starting || this.isDestroyed || (!this.wantsPlayback && !this.previewRequested)) return
    this.starting = true
    let generation = this.generation
    try {
      const metadata =
        this.metadata ??
        (await probeVideo(this.source, this.ffprobePath, this.spawnProcess, (child) => {
          if (generation === this.generation) this.probeProcess = child
        }))
      this.probeProcess = null
      if (this.isDestroyed || (!this.wantsPlayback && !this.previewRequested) || generation !== this.generation) return
      if (!this.metadata) {
        this.metadata = metadata
        this.positionSeconds = normalizeVideoTime(this.positionSeconds, metadata.duration, this.loopPlayback)
        this.onReady?.(metadata)
        if (generation !== this.generation || this.isDestroyed || (!this.wantsPlayback && !this.previewRequested))
          return
      }
      const geometry = this.calculateGeometry(metadata)
      const fps = Math.min(metadata.fps, this.maxFps)
      const key = `${geometry.pixelWidth}x${geometry.pixelHeight}:${this.fitMode}:${fps}:${this.mutedPlayback}`
      if (this.process && key === this.configurationKey) return
      const restartPosition = this.currentTime
      this.stopPlayback(false)
      if ((!this.wantsPlayback && !this.previewRequested) || this.isDestroyed) return
      generation = this.generation
      this.positionSeconds = restartPosition
      this.configurationKey = key
      this.geometry = geometry
      this.startProcess(metadata, geometry, fps, this.positionSeconds, this.previewRequested)
    } catch (error) {
      if (generation !== this.generation || this.isDestroyed || (!this.wantsPlayback && !this.previewRequested)) return
      this.stopPlayback(false)
      this.previewRequested = false
      this.reportError(error)
      this.wantsPlayback = false
    } finally {
      this.starting = false
    }
  }

  private startProcess(
    metadata: VideoMetadata,
    geometry: VideoOutputGeometry,
    fps: number,
    startTime: number,
    preview: boolean,
  ): void {
    const generation = this.generation
    const outputAudio = metadata.hasAudio && !this.mutedPlayback && !preview
    const child = this.spawnProcess(
      this.ffmpegPath,
      buildFfmpegArgs(
        this.source,
        geometry,
        fps,
        metadata,
        this.loopPlayback,
        this.mutedPlayback || preview,
        startTime,
        preview,
      ),
      {
        shell: false,
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      },
    )
    this.process = child
    this.decoderEnded = false
    this.processOriginSeconds = startTime
    this.wallClock = !outputAudio
    this.wallClockOffsetSeconds = 0
    this.audioOutputEnded = !outputAudio
    this.playbackStartedAt = performance.now()
    this.startTicker(fps)

    const video = child.stdio[3] as Readable | null
    const audio = child.stdio[4] as Readable | null
    if (!video) throw new Error("FFmpeg video pipe was not created")
    const parser = new PngStreamParser((png) => {
      if (generation === this.generation && child === this.process) this.acceptVideoFrame(png, geometry)
    })
    video.on("data", (chunk: Buffer) => {
      if (generation === this.generation && child === this.process) {
        try {
          parser.push(chunk)
        } catch (error) {
          this.positionSeconds = this.currentTime
          this.reportError(error)
          this.wantsPlayback = false
          this.stopPlayback(false)
        }
      }
    })
    video.once("end", () => {
      if (generation !== this.generation || child !== this.process) return
      try {
        parser.finish()
      } catch (error) {
        this.reportError(error)
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
        this.positionSeconds = this.currentTime
        this.reportError(new Error(`ffmpeg failed (${code ?? signal ?? "signal"}): ${this.diagnostics.trim()}`))
        this.wantsPlayback = false
        return
      }
      this.decoderEnded = true
    })

    if (outputAudio && audio) this.startAudio(audio, generation)
    else if (outputAudio) {
      this.wallClock = true
      this.playbackStartedAt = performance.now()
    }
  }

  private acceptVideoFrame(png: Uint8Array, geometry: VideoOutputGeometry): void {
    const image = NativeImage.decode(png)
    if (image.width !== geometry.pixelWidth || image.height !== geometry.pixelHeight) {
      image.dispose()
      throw new Error("Unexpected FFmpeg PNG dimensions")
    }
    const frame = { index: this.decodedFrameIndex++, image }
    const desired = this.desiredFrameIndex()
    if (this.frames.length < MAX_VIDEO_QUEUE) this.frames.push(frame)
    else if (this.frames[0].index <= desired) {
      this.frames.shift()?.image.dispose()
      this.frames.push(frame)
    } else image.dispose()
    if (frame.index === 0) this.presentDueFrame()
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
        if (!this.decoderEnded) return
        const drained = this.audioClock
          ? (this.audio?.getPcmQueuedFrames() ?? 0) === 0 && this.audioPending.byteLength < AUDIO_CHANNELS * 4
          : this.frames.length === 0
        if (!drained) return
        const finalPosition = this.duration > 0 ? this.duration : this.currentTime
        this.wantsPlayback = false
        this.playbackEnded = true
        this.positionSeconds = finalPosition
        this.stopTicker()
        this.onTimeUpdate?.(this.positionSeconds)
        this.onEnd?.()
      },
      Math.max(4, Math.floor(1000 / fps / 2)),
    )
  }

  private desiredFrameIndex(): number {
    const fps = Math.min(this.metadata?.fps ?? this.maxFps, this.maxFps)
    return Math.floor(this.processElapsedTime() * fps)
  }

  private processElapsedTime(): number {
    if (this.audioClock && this.audio) return Number(this.audio.getPcmConsumedFrames()) / AUDIO_SAMPLE_RATE
    if (this.wallClock)
      return this.wallClockOffsetSeconds + Math.max(0, performance.now() - this.playbackStartedAt) / 1000
    return 0
  }

  private presentDueFrame(): void {
    const desired = this.desiredFrameIndex()
    let selected: QueuedFrame | undefined
    while (this.frames.length > 0 && this.frames[0].index <= desired) {
      selected?.image.dispose()
      selected = this.frames.shift()
    }
    if (!selected) return
    const previous = this.currentImage
    this.currentImage = selected.image
    previous?.dispose()
    this.requestRender()
    this.positionSeconds = this.currentTime
    this.onTimeUpdate?.(this.positionSeconds)
    if (this.previewRequested && !this.wantsPlayback) {
      this.previewRequested = false
      this.stopPlayback(false)
    }
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  private stopPlayback(clearImage: boolean): void {
    this.generation++
    releaseVideoProcess(this.probeProcess)
    this.probeProcess = null
    releaseVideoProcess(this.process)
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
    for (const frame of this.frames) frame.image.dispose()
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
    this.previewRequested = false
    this.stopPlayback(true)
    super.destroySelf()
  }
}
