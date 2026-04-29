import { describe, expect, test } from "bun:test"
import { createBunBackend, toPointer, type FFICallbackInstance, type Pointer } from "./ffi.js"

function createMockBackend() {
  const events: string[] = []
  const symbolDefinitions: unknown[] = []
  const callbackDefinitions: unknown[] = []
  const toArrayBufferPointers: number[] = []
  const rawCallbacks: MockJSCallback[] = []
  let nextPtr = 1

  class MockJSCallback implements FFICallbackInstance {
    ptr: Pointer | null
    readonly threadsafe: boolean
    closeCount = 0

    constructor(_callback: (...args: any[]) => any, definition: { readonly threadsafe?: boolean }) {
      this.ptr = nextPtr++ as Pointer
      this.threadsafe = definition.threadsafe ?? false
      callbackDefinitions.push(definition)
      rawCallbacks.push(this)
    }

    close(): void {
      if (this.closeCount > 0) {
        return
      }

      this.closeCount++
      events.push(`callback.close:${this.ptr}`)
      this.ptr = null
    }
  }

  const backend = createBunBackend({
    JSCallback: MockJSCallback,
    dlopen(_path, symbols) {
      symbolDefinitions.push(symbols)

      return {
        symbols: Object.fromEntries(Object.keys(symbols).map((name) => [name, () => undefined])) as any,
        close() {
          events.push("library.close")
        },
      }
    },
    ptr() {
      return 1 as Pointer
    },
    suffix: ".mock",
    toArrayBuffer(pointer, _offset, length) {
      toArrayBufferPointers.push(pointer)
      return new ArrayBuffer(length)
    },
  })

  return { backend, callbackDefinitions, events, rawCallbacks, symbolDefinitions, toArrayBufferPointers }
}

describe("platform/ffi", () => {
  test("closes the native library before auto-closing managed callbacks", () => {
    const { backend, events, rawCallbacks } = createMockBackend()
    const library = backend.dlopen("mock", {})

    const first = library.createCallback(() => undefined, { returns: "void" })
    const second = library.createCallback(() => undefined, { returns: "void" })

    expect(first.ptr).toBe(1 as Pointer)
    expect(second.ptr).toBe(2 as Pointer)

    library.close()

    expect(events).toEqual(["library.close", "callback.close:1", "callback.close:2"])
    expect(first.ptr).toBeNull()
    expect(second.ptr).toBeNull()
    expect(rawCallbacks.map((callback) => callback.closeCount)).toEqual([1, 1])

    library.close()
    first.close()

    expect(events).toEqual(["library.close", "callback.close:1", "callback.close:2"])
    expect(rawCallbacks.map((callback) => callback.closeCount)).toEqual([1, 1])
  })

  test("removes explicitly closed callbacks from library-owned cleanup", () => {
    const { backend, events, rawCallbacks } = createMockBackend()
    const library = backend.dlopen("mock", {})
    const callback = library.createCallback(() => undefined, { returns: "void" })

    callback.close()
    callback.close()
    library.close()

    expect(callback.ptr).toBeNull()
    expect(events).toEqual(["callback.close:1", "library.close"])
    expect(rawCallbacks[0]?.closeCount).toBe(1)
  })

  test("throws when creating a callback after library close", () => {
    const { backend } = createMockBackend()
    const library = backend.dlopen("mock", {})

    library.close()

    expect(() => library.createCallback(() => undefined, { returns: "void" })).toThrow(
      "Cannot create FFI callback after library.close() has been called.",
    )
  })

  test("normalizes safe bigint pointers at the Bun backend boundary", () => {
    const { backend, callbackDefinitions, symbolDefinitions, toArrayBufferPointers } = createMockBackend()

    backend.dlopen("mock", { withPtr: { ptr: 12n as Pointer } })
    expect((symbolDefinitions[0] as any).withPtr.ptr).toBe(12)

    const library = backend.dlopen("mock", {})
    library.createCallback(() => undefined, { ptr: 13n as Pointer, returns: "void" })
    expect((callbackDefinitions[0] as any).ptr).toBe(13)

    backend.toArrayBuffer(14n as Pointer, 0, 1)
    expect(toArrayBufferPointers).toEqual([14])
  })

  test("rejects unsafe bigint pointer narrowing", () => {
    const { backend } = createMockBackend()
    const unsafePointer = (BigInt(Number.MAX_SAFE_INTEGER) + 1n) as Pointer
    const negativePointer = -1n as Pointer

    expect(toPointer(1n)).toBe(1 as Pointer)
    expect(() => toPointer(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow("Pointer exceeds safe integer range")
    expect(() => toPointer(-1n)).toThrow("Pointer must be non-negative")
    expect(() => backend.toArrayBuffer(unsafePointer, 0, 1)).toThrow("Pointer exceeds safe integer range")
    expect(() => backend.dlopen("mock", { withPtr: { ptr: unsafePointer } })).toThrow(
      "Pointer exceeds safe integer range",
    )

    const library = backend.dlopen("mock", {})
    expect(() => library.createCallback(() => undefined, { ptr: negativePointer, returns: "void" })).toThrow(
      "Pointer must be non-negative",
    )
  })
})
