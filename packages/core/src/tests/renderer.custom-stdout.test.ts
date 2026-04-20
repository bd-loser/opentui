import { test, expect, afterEach } from "bun:test"
import { Readable, Writable } from "stream"
import { createCliRenderer, CliRenderer, CliRenderEvents } from "../renderer.js"

// Collecting Writable used as a mock stdout. Because it is !== process.stdout,
// createCliRenderer allocates a NativeSpanFeed and pipes bytes through it.
class CollectingWriteStream extends Writable {
  public readonly isTTY = true
  public readonly columns: number
  public readonly rows: number
  public readonly writes: Buffer[] = []
  /** When > 0, delay the write callback by this many ms to simulate a slow consumer. */
  public delayMs = 0

  constructor(columns: number = 80, rows: number = 24) {
    super()
    this.columns = columns
    this.rows = rows
  }

  override _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    // Defensive copy: `Buffer.from(Uint8Array)` can alias the source's
    // underlying ArrayBuffer. For feed-backed renderers the source is a view
    // into Zig-owned chunk memory that is freed when the feed closes. Copy
    // into a standalone Buffer so reads in assertions are safe after teardown.
    const buf = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk.slice())
    this.writes.push(buf)
    if (this.delayMs > 0) {
      setTimeout(callback, this.delayMs)
    } else {
      callback()
    }
  }

  getColorDepth(): number {
    return 24
  }

  getWrittenBytes(): Buffer {
    return Buffer.concat(this.writes)
  }

  clearWrites(): void {
    this.writes.length = 0
  }
}

function createNullReadable(): NodeJS.ReadStream {
  return new Readable({ read() {} }) as NodeJS.ReadStream
}

let destroyFns: Array<() => void> = []

afterEach(() => {
  for (const fn of destroyFns) {
    try {
      fn()
    } catch (e) {
      console.error("cleanup error:", e)
    }
  }
  destroyFns = []
})

// ---- Byte-routing behavior ----

test("non-process stdout: rendered bytes flow to the custom Writable", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(80, 24) as unknown as CollectingWriteStream & NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: false,
  })
  destroyFns.push(() => renderer.destroy())

  // Let setup writes settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 30))

  const received = stdout.getWrittenBytes()
  expect(received.length).toBeGreaterThan(0)
  // ANSI escape sequences contain ESC (0x1b).
  expect(received.includes(0x1b)).toBe(true)
})

test("process.stdout: no feed is allocated (stdout-direct path)", async () => {
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    testing: true,
  })
  // Direct private-field inspection: no feed should be allocated when output
  // goes straight to process.stdout.
  expect((renderer as any)._feed).toBeNull()
  expect(() => renderer.destroy()).not.toThrow()
})

test("omitting stdin/stdout uses process streams", async () => {
  const renderer = await createCliRenderer({
    testing: true,
  })
  expect(renderer.stdin).toBe(process.stdin)
  destroyFns.push(() => renderer.destroy())
})

// ---- Shutdown bytes reach the remote Writable (F1 regression test) ----

test("destroy emits shutdown ANSI sequence through the custom Writable", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(80, 24) as unknown as CollectingWriteStream & NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: false,
  })

  // Let setup output settle, then clear so we can isolate shutdown output.
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  stdout.clearWrites()

  renderer.destroy()

  // Let final writes settle.
  await new Promise<void>((resolve) => setTimeout(resolve, 50))

  const shutdownBytes = stdout.getWrittenBytes().toString("binary")

  // The shutdown sequence must include at least:
  //   - showCursor (ANSI.showCursor = ESC[?25h) so the user isn't left with a hidden cursor
  //   - either the reset-cursor-color sequence or the default-cursor-style sequence
  // This is the regression test for the teardown-order bug where the data
  // handler was detached before destroyRenderer emitted shutdown, causing
  // those bytes to be discarded.
  expect(shutdownBytes.length).toBeGreaterThan(0)
  expect(shutdownBytes).toContain("\x1b[?25h") // showCursor
})

// ---- Backpressure ----

test("slow Writable keeps feed chunks pinned while writes are in-flight", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(80, 24) as unknown as CollectingWriteStream & NodeJS.WriteStream
  // 40 ms delay per write keeps the Promise returned by onData unresolved,
  // which in turn keeps the feed chunk refcount held — the backpressure
  // mechanism we want to verify is actually engaging.
  stdout.delayMs = 40

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: false,
  })
  destroyFns.push(() => {
    stdout.delayMs = 0 // let teardown drain quickly
    renderer.destroy()
  })

  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()

  // Fire several renders without waiting for the 40 ms writes to drain.
  // The TS-side `pendingAsyncHandlers` counter tracks chunks still pinned by
  // unresolved onData Promises — this is the concrete backpressure signal
  // the renderer relies on, not the Zig-side span queue (which drains
  // synchronously on DataAvailable).
  let maxPinned = 0
  for (let i = 0; i < 8; i++) {
    ;(renderer as any).requestRender()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const pinned = (feed as any).pendingAsyncHandlers as number
    if (pinned > maxPinned) maxPinned = pinned
  }

  // At least one chunk must be pinned while writes are outstanding.
  // Zero would mean the feed cycled chunks instantly with no backpressure.
  expect(maxPinned).toBeGreaterThanOrEqual(1)
})

// ---- Dimension fallback ----

test("dimensions: stdout.columns wins over config.width", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(120, 30) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: 40,
    height: 10,
    testing: true,
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(120)
  expect(renderer.height).toBe(30)
})

test("dimensions: config.width used when stdout lacks columns", async () => {
  const stdin = createNullReadable()
  const stdout = new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    width: 100,
    height: 50,
    testing: true,
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(100)
  expect(renderer.height).toBe(50)
})

test("dimensions: defaults 80x24 when no stdout columns and no config", async () => {
  const stdin = createNullReadable()
  const stdout = new Writable({
    write(_c, _e, cb) {
      cb()
    },
  }) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: true,
  })
  destroyFns.push(() => renderer.destroy())

  expect(renderer.width).toBe(80)
  expect(renderer.height).toBe(24)
})

// ---- Duck-typed stream capabilities ----

test("stdin without setRawMode: start/suspend/resume/destroy all succeed", async () => {
  const stdin = createNullReadable() // Readable has no setRawMode
  const stdout = new CollectingWriteStream(80, 24) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: true,
  })

  expect(() => renderer.suspend()).not.toThrow()
  expect(() => renderer.resume()).not.toThrow()
  expect(() => renderer.destroy()).not.toThrow()
})

// ---- Public resize API ----

test("resize(w, h) updates dimensions and fires RESIZE event", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(80, 24) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: true,
  })
  destroyFns.push(() => renderer.destroy())

  let eventFired = false
  let eventW = 0
  let eventH = 0
  renderer.on(CliRenderEvents.RESIZE, (w: number, h: number) => {
    eventFired = true
    eventW = w
    eventH = h
  })

  renderer.resize(120, 40)

  expect(eventFired).toBe(true)
  expect(eventW).toBe(120)
  expect(eventH).toBe(40)
  expect(renderer.width).toBe(120)
  expect(renderer.height).toBe(40)
})

test("resize() after destroy is a no-op", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(80, 24) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: true,
  })

  renderer.destroy()
  expect(() => renderer.resize(100, 50)).not.toThrow()
})

// ---- Full feed teardown path ----

test("full feed teardown after successful setup does not throw", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(80, 24) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: false,
  })
  // Exercises the full drain → destroyRenderer → drain → detach → close path.
  expect(() => renderer.destroy()).not.toThrow()
})

// ---- Destroy resilience ----

test("destroy tolerates drainAll throwing", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(80, 24) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: false,
  })

  // Monkey-patch drainAll on the private feed handle to throw on the first
  // two calls (one before destroyRenderer, one after), then pass through.
  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()
  const originalDrainAll = feed.drainAll.bind(feed)
  let calls = 0
  feed.drainAll = () => {
    calls++
    if (calls <= 2) throw new Error("simulated drain failure")
    return originalDrainAll()
  }

  // destroy must swallow the drainAll exceptions and still complete the
  // rest of the teardown path.
  expect(() => renderer.destroy()).not.toThrow()
  expect(calls).toBeGreaterThanOrEqual(2)
})

// ---- onError handler wire-up ----

test("feed.onError handler registration and detach work", async () => {
  const stdin = createNullReadable()
  const stdout = new CollectingWriteStream(80, 24) as unknown as NodeJS.WriteStream

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    testing: false,
  })
  destroyFns.push(() => renderer.destroy())

  // The renderer-internal handler is already registered. We register a
  // secondary one and verify the detach function it returns.
  //
  // Note: this test only verifies the wire-up (subscribe + detach). There
  // is currently no supported API to synthetically trigger an EventId.Error
  // event on the feed, so end-to-end invocation is a coverage gap tracked
  // for a future NativeSpanFeed test-harness hook.
  const feed = (renderer as any)._feed
  expect(feed).not.toBeNull()
  const detach = feed.onError(() => {})
  expect(typeof detach).toBe("function")
  expect(() => detach()).not.toThrow()
})
