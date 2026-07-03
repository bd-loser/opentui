import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test"
import { act, useState } from "react"
import { fileURLToPath } from "node:url"
import { ImageRenderable, VideoRenderable } from "@opentui/core"
import { testRender } from "../src/test-utils.js"

let originalConsoleError: (...args: any[]) => void

beforeAll(() => {
  originalConsoleError = console.error
  console.error = mock(() => {})
})

afterAll(() => {
  console.error = originalConsoleError
})

const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWP4z8DwHwAFAAH/e+m+7wAAAABJRU5ErkJggg==",
    "base64",
  ),
)
const VIDEO_FIXTURE = fileURLToPath(new URL("../../core/src/tests/fixtures/video/dragon.mp4", import.meta.url))

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  testSetup?.renderer.destroy()
  testSetup = undefined
})

describe("React Renderer | image element", () => {
  it("creates an ImageRenderable and loads encoded bytes", async () => {
    let imageRef: ImageRenderable | null = null
    const loaded: string[] = []

    testSetup = await testRender(
      <image
        ref={(renderable: ImageRenderable | null) => {
          imageRef = renderable
        }}
        source={PNG_1X1}
        onLoad={(image) => loaded.push(image.info().format)}
        style={{ width: 4, height: 2 }}
      />,
      { width: 10, height: 6 },
    )
    await testSetup.renderOnce()

    expect(imageRef).toBeInstanceOf(ImageRenderable)
    await imageRef!.loadPromise
    expect(loaded).toEqual(["png"])
    expect(imageRef!.image?.width).toBe(1)
    expect(imageRef!.loadError).toBeNull()
  })
})

describe("React Renderer | video element", () => {
  it("creates a VideoRenderable and opens real media", async () => {
    let videoRef: VideoRenderable | null = null
    const readies: number[] = []
    const failures: string[] = []

    testSetup = await testRender(
      <video
        ref={(renderable: VideoRenderable | null) => {
          videoRef = renderable
        }}
        source={VIDEO_FIXTURE}
        muted
        onReady={(metadata) => readies.push(metadata.width)}
        onError={(error) => failures.push(error.message)}
        style={{ width: 8, height: 4 }}
      />,
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

  it("swaps media when the source prop changes", async () => {
    let videoRef: VideoRenderable | null = null
    const failures: string[] = []
    let updateSource: (value: string) => void = () => {}

    function App() {
      const [source, setSource] = useState("/nonexistent/opentui-missing.mp4")
      updateSource = setSource
      return (
        <video
          ref={(renderable: VideoRenderable | null) => {
            videoRef = renderable
          }}
          source={source}
          muted
          onError={(error) => failures.push(error.message)}
          style={{ width: 8, height: 4 }}
        />
      )
    }

    testSetup = await testRender(<App />, { width: 12, height: 6 })
    await testSetup.renderOnce()
    expect(failures.length).toBe(1)
    expect(videoRef!.ready).toBe(false)

    await act(async () => {
      updateSource(VIDEO_FIXTURE)
    })
    await testSetup.renderOnce()
    expect(videoRef!.ready).toBe(true)
    expect(videoRef!.videoMetadata?.height).toBe(1168)
  })
})
