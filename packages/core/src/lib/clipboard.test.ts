import { describe, expect, it, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { ClipboardTarget, encodeOsc52Payload } from "./clipboard.js"
import type { RenderLib } from "../zig.js"

describe("clipboard", () => {
  let renderer: TestRenderer | null = null

  const respondToOsc52Query = (testRenderer: TestRenderer, response: string) => {
    const lib = (testRenderer as unknown as { lib: RenderLib }).lib
    lib.processCapabilityResponse(testRenderer.rendererPtr, response)
  }

  afterEach(() => {
    renderer?.destroy()
    renderer = null
  })

  it("encodes payload as base64", () => {
    const payload = encodeOsc52Payload("hello")
    const decoded = new TextDecoder().decode(payload)
    expect(decoded).toBe(Buffer.from("hello").toString("base64"))
  })

  it("treats negative XTGETTCAP Ms replies as inconclusive", async () => {
    ;({ renderer } = await createTestRenderer({ remote: true }))

    expect(renderer.isOsc52Supported()).toBe(true)
    expect(renderer.copyToClipboardOSC52("test")).toBe(true)

    respondToOsc52Query(renderer, "\x1bP0+r\x1b\\")
    expect(renderer.copyToClipboardOSC52("test")).toBe(true)
    expect(renderer.clearClipboardOSC52()).toBe(true)

    respondToOsc52Query(renderer, "\x1bP0+r4d73\x1b\\")
    expect(renderer.copyToClipboardOSC52("test")).toBe(true)

    respondToOsc52Query(renderer, "\x1bP1+r4d73=2570312573\x1b\\")

    expect(renderer.copyToClipboardOSC52("test")).toBe(true)
    expect(renderer.copyToClipboardOSC52("test", ClipboardTarget.Primary)).toBe(true)
    expect(renderer.copyToClipboardOSC52("test", ClipboardTarget.Secondary)).toBe(true)
    expect(renderer.copyToClipboardOSC52("test", ClipboardTarget.Query)).toBe(true)
    expect(renderer.clearClipboardOSC52()).toBe(true)
  })
})
