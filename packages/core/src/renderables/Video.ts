import type { OptimizedBuffer } from "../buffer.js"
import { NativeImage } from "../image.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import type { ImageRenderProtocol, RenderContext } from "../types.js"
import { NativeVideo, type NativeVideoState } from "../video.js"
import { resolveImageRenderProtocol, type ImageFit } from "./Image.js"

export interface VideoMetadata {
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
  volume?: number
  maxFps?: number
  onReady?: (metadata: VideoMetadata) => void
  onError?: (error: Error) => void
  onEnd?: () => void
  onPlay?: () => void
  onPause?: () => void
  onSeek?: (time: number) => void
  onTimeUpdate?: (time: number) => void
}

export interface VideoOutputGeometry {
  cellWidth: number
  cellHeight: number
  pixelWidth: number
  pixelHeight: number
  decodeWidth: number
  decodeHeight: number
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

export interface AdaptiveVideoQualityState {
  tier: number
  updateTimeMs: number
  overloadSamples: number
  headroomSamples: number
  cooldownSamples: number
  lastFrameSerial: bigint | null
  lastBackpressureCount: number
}

export interface AdaptiveVideoQualitySample {
  updateTimeMs: number
  frameBudgetMs: number
  frameSerial: bigint
  expectedFrameStep: bigint
  backpressureCount: number
}

export interface VideoQualityTier {
  readonly index: number
  readonly total: number
  readonly label: string
  readonly bitsPerChannel: readonly [number, number, number]
  readonly lossless: boolean
  readonly compressionLevel: number
  readonly predictor: "none" | "up" | "paeth"
}

const VIDEO_QUALITY_TIER_COUNT = 6
const VIDEO_PNG_PREDICTORS = { none: 0, up: 2, paeth: 4 } as const
const VIDEO_CPU_OVERLOAD_RATIO = 0.7
const VIDEO_QUALITY_RECOVERY_RATIO = 0.65
const VIDEO_OVERLOAD_SCORE_LIMIT = 8
const VIDEO_OVERLOAD_SCORE_RECOVERY = 2
const VIDEO_HEADROOM_PRESSURE_PENALTY = 4

function videoQualityTier(
  index: number,
  label: string,
  bitsPerChannel: readonly [number, number, number],
  lossless: boolean,
  compressionLevel: number,
  predictor: VideoQualityTier["predictor"],
  colorMode: number,
) {
  return {
    info: { index, total: VIDEO_QUALITY_TIER_COUNT, label, bitsPerChannel, lossless, compressionLevel, predictor },
    colorMode,
  }
}

const VIDEO_PNG_QUALITY_TIERS = [
  videoQualityTier(0, "RGB888", [8, 8, 8], true, 1, "up", 1),
  videoQualityTier(1, "RGB777", [7, 7, 7], false, 1, "up", 6),
  videoQualityTier(2, "RGB666", [6, 6, 6], false, 1, "up", 5),
  videoQualityTier(3, "RGB444", [4, 4, 4], false, 1, "up", 2),
  videoQualityTier(4, "RGB343", [3, 4, 3], false, 2, "none", 0),
  videoQualityTier(5, "PAL332", [3, 3, 2], false, 1, "paeth", 4),
] as const

export function createAdaptiveVideoQualityState(backpressureCount = 0): AdaptiveVideoQualityState {
  return {
    tier: 0,
    updateTimeMs: 0,
    overloadSamples: 0,
    headroomSamples: 0,
    cooldownSamples: 0,
    lastFrameSerial: null,
    lastBackpressureCount: backpressureCount,
  }
}

export function updateAdaptiveVideoQuality(
  state: AdaptiveVideoQualityState,
  sample: AdaptiveVideoQualitySample,
): AdaptiveVideoQualityState {
  const updateTimeMs =
    state.updateTimeMs === 0 ? sample.updateTimeMs : state.updateTimeMs * 0.9 + sample.updateTimeMs * 0.1
  const frameStepTolerance = sample.expectedFrameStep > 1n ? 1n : 0n
  const skippedFrames =
    state.lastFrameSerial !== null &&
    sample.frameSerial > state.lastFrameSerial + sample.expectedFrameStep + frameStepTolerance
  const backpressured = sample.backpressureCount > state.lastBackpressureCount
  const cpuOverloaded = updateTimeMs > sample.frameBudgetMs * VIDEO_CPU_OVERLOAD_RATIO
  const overloaded = cpuOverloaded || skippedFrames || backpressured
  let overloadSamples = overloaded
    ? state.overloadSamples + 1
    : Math.max(0, state.overloadSamples - VIDEO_OVERLOAD_SCORE_RECOVERY)
  let headroomSamples =
    !overloaded && updateTimeMs < sample.frameBudgetMs * VIDEO_QUALITY_RECOVERY_RATIO
      ? state.headroomSamples + 1
      : Math.max(0, state.headroomSamples - VIDEO_HEADROOM_PRESSURE_PENALTY)
  let cooldownSamples = Math.max(0, state.cooldownSamples - 1)
  let tier = state.tier

  if (state.cooldownSamples > 0) overloadSamples = 0

  if (
    cooldownSamples === 0 &&
    overloadSamples >= VIDEO_OVERLOAD_SCORE_LIMIT &&
    tier < VIDEO_PNG_QUALITY_TIERS.length - 1
  ) {
    tier++
    overloadSamples = 0
    headroomSamples = 0
    cooldownSamples = 30
  } else if (cooldownSamples === 0 && headroomSamples >= 120 && tier > 0) {
    tier--
    overloadSamples = 0
    headroomSamples = 0
    cooldownSamples = 30
  }

  return {
    tier,
    updateTimeMs,
    overloadSamples,
    headroomSamples,
    cooldownSamples,
    lastFrameSerial: sample.frameSerial,
    lastBackpressureCount: sample.backpressureCount,
  }
}

const MAX_VIDEO_FPS = 30

export function calculateVideoPlaybackFps(sourceFps: number, requestedMaxFps: number): number {
  return Math.min(sourceFps > 0 ? sourceFps : requestedMaxFps, requestedMaxFps, MAX_VIDEO_FPS)
}

export function calculateVideoTickFps(sourceFps: number, requestedMaxFps: number, hasAudio: boolean): number {
  const playbackFps = calculateVideoPlaybackFps(sourceFps, requestedMaxFps)
  return hasAudio ? Math.max(playbackFps, 15) : playbackFps
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
  const decodeScale = Math.min(1, sourceWidth / pixelWidth, sourceHeight / pixelHeight)
  const decodeWidth = Math.max(1, Math.round(pixelWidth * decodeScale))
  const decodeHeight = Math.max(1, Math.round(pixelHeight * decodeScale))
  return { cellWidth, cellHeight, pixelWidth, pixelHeight, decodeWidth, decodeHeight }
}

export class VideoRenderable extends Renderable {
  private readonly source: string
  private readonly loopPlayback: boolean
  private readonly maxFps: number
  private readonly onReady?: (metadata: VideoMetadata) => void
  private readonly onError?: (error: Error) => void
  private readonly onEnd?: () => void
  private readonly onPlay?: () => void
  private readonly onPause?: () => void
  private readonly onSeek?: (time: number) => void
  private readonly onTimeUpdate?: (time: number) => void
  private fitMode: ImageFit
  private renderProtocol: ImageRenderProtocol
  private mutedPlayback: boolean
  private volumeLevel: number
  private native: NativeVideo | null = null
  private metadata: VideoMetadata | null = null
  private currentImage: NativeImage | null = null
  private geometry: VideoOutputGeometry | null = null
  private wallClock = false
  private positionSeconds = 0
  private playbackStartedAt = 0
  private wantsPlayback: boolean
  private playbackEnded = false
  private ticker: ReturnType<typeof setTimeout> | null = null
  private updating = false
  private adaptiveQuality: AdaptiveVideoQualityState

  constructor(ctx: RenderContext, options: VideoRenderableOptions) {
    super(ctx, options)
    this.source = options.source
    this.fitMode = options.fit ?? "fit"
    this.renderProtocol = options.protocol ?? "auto"
    this.loopPlayback = options.loop ?? false
    this.mutedPlayback = options.muted ?? false
    this.volumeLevel = options.volume ?? 1
    if (!Number.isFinite(this.volumeLevel) || this.volumeLevel < 0)
      throw new RangeError("volume must be finite and non-negative")
    const maxFps = options.maxFps ?? 30
    if (!Number.isFinite(maxFps) || maxFps <= 0) throw new RangeError("maxFps must be a positive finite number")
    this.maxFps = maxFps
    this.onReady = options.onReady
    this.onError = options.onError
    this.onEnd = options.onEnd
    this.onPlay = options.onPlay
    this.onPause = options.onPause
    this.onSeek = options.onSeek
    this.onTimeUpdate = options.onTimeUpdate
    this.wantsPlayback = options.autoplay ?? false
    this.adaptiveQuality = createAdaptiveVideoQualityState(ctx.renderBackpressureCount ?? 0)
  }

  public get fit(): ImageFit {
    return this.fitMode
  }

  public set fit(value: ImageFit) {
    if (this.fitMode === value) return
    this.fitMode = value
    this.geometry = null
    this.requestRender()
  }

  public get protocol(): ImageRenderProtocol {
    return this.renderProtocol
  }

  public get effectiveProtocol(): Exclude<ImageRenderProtocol, "auto"> {
    return resolveImageRenderProtocol(this.renderProtocol, this._ctx.capabilities, this._ctx.resolution !== null)
  }

  public get qualityTier(): VideoQualityTier {
    const info = VIDEO_PNG_QUALITY_TIERS[this.adaptiveQuality.tier].info
    return { ...info, bitsPerChannel: [...info.bitsPerChannel] }
  }

  public set protocol(value: ImageRenderProtocol) {
    if (this.renderProtocol === value) return
    this.renderProtocol = value
    this.requestRender()
  }

  public get muted(): boolean {
    return this.mutedPlayback
  }

  public set muted(value: boolean) {
    if (this.mutedPlayback === value) return
    this.mutedPlayback = value
    this.native?.setMuted(value)
  }

  public get volume(): number {
    return this.volumeLevel
  }

  public set volume(value: number) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("volume must be finite and non-negative")
    if (this.volumeLevel === value) return
    this.volumeLevel = value
    this.native?.setVolume(value)
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

  public get ready(): boolean {
    return this.native !== null
  }

  public get videoMetadata(): Readonly<VideoMetadata> | null {
    return this.metadata ? { ...this.metadata } : null
  }

  public get duration(): number {
    return this.metadata?.duration ?? 0
  }

  public get durationMs(): number {
    return this.duration * 1000
  }

  public get currentTime(): number {
    if (!this.wantsPlayback) return this.positionSeconds
    const state = this.native?.state
    if (state && (state.audioActive || state.buffering)) return state.currentTime
    return normalizeVideoTime(this.positionSeconds + this.clockElapsed(), this.duration, this.loopPlayback)
  }

  public set currentTime(value: number) {
    this.seek(value)
  }

  public get currentTimeMs(): number {
    return this.currentTime * 1000
  }

  public play(): void {
    if (this.wantsPlayback && !this.playbackEnded) return
    if (this.playbackEnded && !this.loopPlayback) this.seek(0)
    this.wantsPlayback = true
    this.playbackEnded = false
    if (!this.ensureNative()) return
    this.native!.play()
    this.startClock()
    this.startTicker()
    this.onPlay?.()
  }

  public resume(): void {
    this.play()
  }

  public pause(): void {
    if (!this.wantsPlayback) return
    this.positionSeconds = this.currentTime
    this.wantsPlayback = false
    this.stopTicker()
    this.native?.pause()
    this.wallClock = false
    this.onPause?.()
    this.onTimeUpdate?.(this.positionSeconds)
  }

  public toggle(): void {
    if (this.wantsPlayback) this.pause()
    else this.play()
  }

  public seek(time: number): void {
    const target = normalizeVideoTime(time, this.duration, this.loopPlayback)
    this.positionSeconds = target
    this.playbackEnded = false
    if (!this.ensureNative()) return
    try {
      this.native!.seek(target)
      this.resetAdaptiveQualitySamples()
      this.updateFrame(target)
      if (this.wantsPlayback) this.startClock()
      this.onSeek?.(target)
      this.onTimeUpdate?.(target)
    } catch (error) {
      this.reportError(error)
    }
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
    if (!this.ensureNative()) return
    this.ensureGeometry()
    if (!this.currentImage) this.updateFrame(this.positionSeconds)
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

  private ensureNative(): boolean {
    if (this.native) return true
    if (this.isDestroyed) return false
    try {
      this.native = NativeVideo.open(this.source)
      const info = this.native.info
      this.metadata = {
        width: info.width,
        height: info.height,
        fps: info.fps,
        duration: info.duration,
        hasAudio: info.hasAudio,
      }
      this.native.setMuted(this.mutedPlayback)
      this.native.setVolume(this.volumeLevel)
      if (this.wantsPlayback) this.native.play()
      this.onReady?.(this.metadata)
      if (this.wantsPlayback) {
        this.startClock()
        this.startTicker()
      }
      return true
    } catch (error) {
      this.reportError(error)
      this.wantsPlayback = false
      this.stopTicker()
      return false
    }
  }

  private ensureGeometry(): void {
    if (!this.native || !this.metadata || this.width <= 0 || this.height <= 0) return
    const resolution = this._ctx.terminalWidth > 0 && this._ctx.terminalHeight > 0 ? this._ctx.resolution : null
    const next = calculateVideoGeometry({
      fit: this.fitMode,
      sourceWidth: this.metadata.width,
      sourceHeight: this.metadata.height,
      targetWidth: this.width,
      targetHeight: this.height,
      terminalWidth: this._ctx.terminalWidth,
      terminalHeight: this._ctx.terminalHeight,
      resolution,
    })
    if (
      this.geometry?.pixelWidth === next.pixelWidth &&
      this.geometry?.pixelHeight === next.pixelHeight &&
      this.geometry.decodeWidth === next.decodeWidth &&
      this.geometry.decodeHeight === next.decodeHeight
    )
      return
    const position = this.currentTime
    this.geometry = next
    this.native.configureOutput(next.decodeWidth, next.decodeHeight, this.fitMode === "cover")
    this.resetAdaptiveQualitySamples()
    this.updateFrame(position)
  }

  private startClock(): void {
    this.playbackStartedAt = performance.now()
    this.wallClock = true
  }

  private startTicker(): void {
    if (this.ticker) return
    const fps = calculateVideoTickFps(this.metadata?.fps ?? 0, this.maxFps, this.metadata?.hasAudio ?? false)
    const frameTime = 1000 / fps
    const schedule = (): void => {
      if (!this.wantsPlayback || this.isDestroyed) {
        this.ticker = null
        return
      }
      const started = performance.now()
      this.tick()
      if (!this.wantsPlayback || this.isDestroyed) {
        this.ticker = null
        return
      }
      this.ticker = setTimeout(schedule, Math.max(1, frameTime - (performance.now() - started)))
    }
    this.ticker = setTimeout(schedule, frameTime)
  }

  private stopTicker(): void {
    if (this.ticker) clearTimeout(this.ticker)
    this.ticker = null
  }

  private tick(): void {
    if (!this.wantsPlayback || this.updating || !this.native) return
    this.updating = true
    try {
      const unwrappedTime = this.positionSeconds + this.clockElapsed()
      let time = normalizeVideoTime(unwrappedTime, this.duration, this.loopPlayback)
      const nativeState = this.native.state
      const nativeAudioClock = nativeState.audioActive || nativeState.buffering
      if (!nativeAudioClock && this.loopPlayback && this.duration > 0 && unwrappedTime >= this.duration) {
        this.positionSeconds = time
        this.native.seek(time)
        this.resetAdaptiveQualitySamples()
        this.startClock()
        this.updateFrame(time)
        this.onTimeUpdate?.(time)
        return
      }
      if (!nativeAudioClock && !this.loopPlayback && this.duration > 0 && time >= this.duration) {
        time = this.duration
        this.positionSeconds = time
        this.wantsPlayback = false
        this.playbackEnded = true
        this.stopTicker()
        this.native.pause()
        this.onTimeUpdate?.(time)
        this.onEnd?.()
        return
      }
      const updateStarted = performance.now()
      const state = this.updateFrame(time)
      if (state)
        this.updateAdaptiveQuality(
          performance.now() - updateStarted,
          state,
          1000 / calculateVideoPlaybackFps(this.metadata?.fps ?? 0, this.maxFps),
        )
      if (state?.ended) {
        if (this.loopPlayback) {
          this.positionSeconds = 0
          this.native.seek(0)
          this.resetAdaptiveQualitySamples()
          this.startClock()
          this.updateFrame(0)
        } else {
          this.positionSeconds = this.duration || time
          this.wantsPlayback = false
          this.playbackEnded = true
          this.stopTicker()
          this.native.pause()
          this.onTimeUpdate?.(this.positionSeconds)
          this.onEnd?.()
        }
        return
      }
      this.onTimeUpdate?.(state?.currentTime ?? time)
    } catch (error) {
      this.reportError(error)
      this.wantsPlayback = false
      this.stopTicker()
      this.native?.pause()
    } finally {
      this.updating = false
    }
  }

  private updateFrame(time: number) {
    if (!this.native) return null
    const state = this.native.update(time)
    const next = this.native.takeFrame()
    if (!next) return state
    const previous = this.currentImage
    this.currentImage = next
    previous?.dispose()
    this.requestRender()
    return state
  }

  private updateAdaptiveQuality(updateTimeMs: number, state: NativeVideoState, frameBudgetMs: number): void {
    if (!this.native) return
    const next = updateAdaptiveVideoQuality(this.adaptiveQuality, {
      updateTimeMs,
      frameBudgetMs,
      frameSerial: state.frameSerial,
      expectedFrameStep: BigInt(
        Math.max(
          1,
          Math.ceil(
            (this.metadata?.fps ?? this.maxFps) / calculateVideoPlaybackFps(this.metadata?.fps ?? 0, this.maxFps),
          ),
        ),
      ),
      backpressureCount: this._ctx.renderBackpressureCount ?? 0,
    })
    if (next.tier !== this.adaptiveQuality.tier) {
      const quality = VIDEO_PNG_QUALITY_TIERS[next.tier]
      this.native.configurePng(
        quality.info.compressionLevel,
        VIDEO_PNG_PREDICTORS[quality.info.predictor],
        quality.colorMode,
      )
    }
    this.adaptiveQuality = next
  }

  private resetAdaptiveQualitySamples(): void {
    this.adaptiveQuality = {
      ...createAdaptiveVideoQualityState(this._ctx.renderBackpressureCount ?? 0),
      tier: this.adaptiveQuality.tier,
      cooldownSamples: 30,
    }
  }

  private clockElapsed(): number {
    if (this.wallClock) return Math.max(0, performance.now() - this.playbackStartedAt) / 1000
    return 0
  }

  private reportError(error: unknown): void {
    this.onError?.(error instanceof Error ? error : new Error(String(error)))
  }

  protected destroySelf(): void {
    this.wantsPlayback = false
    this.stopTicker()
    this.wallClock = false
    this.currentImage?.dispose()
    this.currentImage = null
    this.native?.dispose()
    this.native = null
    super.destroySelf()
  }
}
