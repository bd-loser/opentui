import { NativeImage } from "./image.js"
import { resolveRenderLib, type RenderLib, type VideoHandle } from "./zig.js"

export interface NativeVideoInfo {
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  audioSampleRate: number
  audioChannels: number
}

export interface NativeVideoState {
  currentTime: number
  framePts: number
  frameSerial: bigint
  hasFrame: boolean
  ended: boolean
  playing: boolean
  buffering: boolean
  audioActive: boolean
  audioEnded: boolean
  audioFailed: boolean
  audioQueuedFrames: number
  audioRefillTimeUs: number
  audioConsumedFrames: bigint
  audioProducedFrames: bigint
  audioUnderruns: bigint
  audioUnderrunFrames: bigint
}

function videoError(lib: RenderLib, handle: VideoHandle | null, status: number): Error {
  const detail = handle ? lib.videoGetError(handle) : ""
  return new Error(detail ? `Native video failed (${status}): ${detail}` : `Native video failed (${status})`)
}

export class NativeVideo {
  public static open(path: string): NativeVideo {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("video path must be a non-empty string")
    const lib = resolveRenderLib()
    const result = lib.videoOpen(path)
    if (result.status !== 0 || !result.handle) throw videoError(lib, result.handle, result.status)
    const info = lib.videoGetInfo(result.handle)
    if (info.status !== 0) {
      lib.videoDestroy(result.handle)
      throw videoError(lib, result.handle, info.status)
    }
    return new NativeVideo(lib, result.handle, {
      duration: Number(info.info.durationUs) / 1_000_000,
      width: info.info.width,
      height: info.info.height,
      fps: info.info.fpsDen > 0 ? info.info.fpsNum / info.info.fpsDen : 0,
      hasAudio: info.info.hasAudio !== 0,
      audioSampleRate: info.info.audioSampleRate,
      audioChannels: info.info.audioChannels,
    })
  }

  private handle: VideoHandle | null
  private frameSerial = 0n

  private constructor(
    private readonly lib: RenderLib,
    handle: VideoHandle,
    public readonly info: NativeVideoInfo,
  ) {
    this.handle = handle
  }

  private guard(): VideoHandle {
    if (!this.handle) throw new Error("NativeVideo is disposed")
    return this.handle
  }

  private unpackState(result: ReturnType<RenderLib["videoGetState"]>): NativeVideoState {
    if (result.status !== 0) throw videoError(this.lib, this.handle, result.status)
    return {
      currentTime: Number(result.state.currentTimeUs) / 1_000_000,
      framePts: Number(result.state.framePtsUs) / 1_000_000,
      frameSerial: result.state.frameSerial,
      hasFrame: result.state.hasFrame !== 0,
      ended: result.state.ended !== 0,
      playing: result.state.playing !== 0,
      buffering: result.state.buffering !== 0,
      audioActive: result.state.audioActive !== 0,
      audioEnded: result.state.audioEnded !== 0,
      audioFailed: result.state.audioFailed !== 0,
      audioQueuedFrames: result.state.audioQueuedFrames,
      audioRefillTimeUs: result.state.audioRefillTimeUs,
      audioConsumedFrames: result.state.audioConsumedFrames,
      audioProducedFrames: result.state.audioProducedFrames,
      audioUnderruns: result.state.audioUnderruns,
      audioUnderrunFrames: result.state.audioUnderrunFrames,
    }
  }

  public get state(): NativeVideoState {
    return this.unpackState(this.lib.videoGetState(this.guard()))
  }

  public play(): void {
    const status = this.lib.videoPlay(this.guard())
    if (status !== 0) throw videoError(this.lib, this.handle, status)
  }

  public pause(): void {
    const status = this.lib.videoPause(this.guard())
    if (status !== 0) throw videoError(this.lib, this.handle, status)
  }

  public setMuted(muted: boolean): void {
    const status = this.lib.videoSetMuted(this.guard(), muted)
    if (status !== 0) throw videoError(this.lib, this.handle, status)
  }

  public setVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0) throw new RangeError("video volume must be finite and non-negative")
    const status = this.lib.videoSetVolume(this.guard(), volume)
    if (status !== 0) throw videoError(this.lib, this.handle, status)
  }

  public configureOutput(width: number, height: number, cover = false): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError("video output dimensions must be positive integers")
    }
    if (width > 16_384 || height > 16_384 || width * height > 25_000_000) {
      throw new RangeError("video output dimensions exceed native image limits")
    }
    const status = this.lib.videoConfigureOutput(this.guard(), width, height, cover)
    if (status !== 0) throw videoError(this.lib, this.handle, status)
    this.frameSerial = 0n
  }

  public configurePng(compressionLevel: number, predictor: number, colorMode: number): void {
    for (const [value, name, maximum] of [
      [compressionLevel, "compression level", 9],
      [predictor, "predictor", 5],
      [colorMode, "color mode", 6],
    ] as const) {
      if (!Number.isInteger(value) || value < 0 || value > maximum) {
        throw new RangeError(`video PNG ${name} must be an integer between 0 and ${maximum}`)
      }
    }
    const status = this.lib.videoConfigurePng(this.guard(), compressionLevel, predictor, colorMode)
    if (status !== 0) throw videoError(this.lib, this.handle, status)
    this.frameSerial = 0n
  }

  public seek(time: number): NativeVideoState {
    if (!Number.isFinite(time) || time < 0) throw new RangeError("video seek time must be finite and non-negative")
    const result = this.lib.videoSeek(this.guard(), BigInt(Math.round(time * 1_000_000)))
    this.frameSerial = 0n
    return this.unpackState(result)
  }

  public update(time: number): NativeVideoState {
    if (!Number.isFinite(time) || time < 0) throw new RangeError("video update time must be finite and non-negative")
    return this.unpackState(this.lib.videoUpdate(this.guard(), BigInt(Math.round(time * 1_000_000))))
  }

  public takeFrame(): NativeImage | null {
    const result = this.lib.videoGetCurrentFrame(this.guard(), this.frameSerial)
    if (result.status === 7) return null
    if (result.status !== 0) throw videoError(this.lib, this.handle, result.status)
    this.frameSerial = result.serial
    return result.handle ? NativeImage.fromRetainedHandle(result.handle) : null
  }

  public readAudio(output: Float32Array): number {
    if (!(output instanceof Float32Array)) throw new TypeError("audio output must be a Float32Array")
    const channels = this.info.audioChannels
    if (channels === 0) return 0
    if (output.length % channels !== 0) throw new RangeError("audio output must contain complete frames")
    const capacityFrames = output.length / channels
    const result = this.lib.videoReadAudio(this.guard(), output, capacityFrames)
    if (result.status !== 0) throw videoError(this.lib, this.handle, result.status)
    return result.frames
  }

  public dispose(): void {
    if (!this.handle) return
    this.lib.videoDestroy(this.handle)
    this.handle = null
  }
}
