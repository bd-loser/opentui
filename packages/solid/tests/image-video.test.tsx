import { describe, expect, it, afterEach } from "bun:test"
import { fileURLToPath } from "node:url"
import { createSignal } from "solid-js"
import { ImageRenderable, VideoRenderable } from "@opentui/core"
import { testRender } from "../index.js"

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
    "base64",
  ),
)
const VIDEO_FIXTURE = fileURLToPath(new URL("../../core/src/tests/fixtures/video/dragon.mp4", import.meta.url))

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

describe("image component", () => {
  afterEach(() => {
    testSetup?.renderer.destroy()
    testSetup = undefined
  })

  it("creates an ImageRenderable and loads encoded bytes", async () => {
    let imageRef: ImageRenderable | undefined
    const loaded: string[] = []

    testSetup = await testRender(
      () => (
        <image
          ref={imageRef}
          source={PNG_1X1}
          onLoad={(image) => loaded.push(image.info().format)}
          style={{ width: 4, height: 2 }}
        />
      ),
      { width: 10, height: 6 },
    )
    await testSetup.renderOnce()

    expect(imageRef).toBeInstanceOf(ImageRenderable)
    await imageRef!.loadPromise
    expect(loaded).toEqual(["png"])
    expect(imageRef!.image?.width).toBe(1)
    expect(imageRef!.loadError).toBeNull()
  })

  it("reloads when the source prop changes reactively", async () => {
    let imageRef: ImageRenderable | undefined
    const [source, setSource] = createSignal<Uint8Array | undefined>(undefined)

    testSetup = await testRender(() => <image ref={imageRef} source={source()} style={{ width: 4, height: 2 }} />, {
      width: 10,
      height: 6,
    })
    await testSetup.renderOnce()
    expect(imageRef!.image).toBeNull()

    setSource(PNG_1X1)
    await testSetup.renderOnce()
    await imageRef!.loadPromise
    expect(imageRef!.image?.info().format).toBe("png")
  })
})

describe("video component", () => {
  afterEach(() => {
    testSetup?.renderer.destroy()
    testSetup = undefined
  })

  it("creates a VideoRenderable and opens real media", async () => {
    let videoRef: VideoRenderable | undefined
    const readies: number[] = []
    const failures: string[] = []

    testSetup = await testRender(
      () => (
        <video
          ref={videoRef}
          source={VIDEO_FIXTURE}
          muted
          onReady={(metadata) => readies.push(metadata.width)}
          onError={(error) => failures.push(error.message)}
          style={{ width: 8, height: 4 }}
        />
      ),
      { width: 12, height: 6 },
    )
    await testSetup.renderOnce()

    expect(videoRef).toBeInstanceOf(VideoRenderable)
    expect(failures).toEqual([])
    expect(readies).toEqual([768])
    expect(videoRef!.ready).toBe(true)
    expect(videoRef!.videoMetadata?.fps).toBe(24)
    expect(videoRef!.paused).toBe(true)
  })

  it("swaps media when the source prop changes reactively", async () => {
    let videoRef: VideoRenderable | undefined
    const failures: string[] = []
    const [source, setSource] = createSignal("/nonexistent/opentui-missing.mp4")

    testSetup = await testRender(
      () => (
        <video
          ref={videoRef}
          source={source()}
          muted
          onError={(error) => failures.push(error.message)}
          style={{ width: 8, height: 4 }}
        />
      ),
      { width: 12, height: 6 },
    )
    await testSetup.renderOnce()
    expect(failures.length).toBe(1)
    expect(videoRef!.ready).toBe(false)

    setSource(VIDEO_FIXTURE)
    await testSetup.renderOnce()
    expect(videoRef!.ready).toBe(true)
    expect(videoRef!.videoMetadata?.height).toBe(1168)
  })
})
