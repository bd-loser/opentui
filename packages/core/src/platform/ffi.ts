declare const pointerBrand: unique symbol

// This module owns OpenTUI's native FFI surface. Portable code imports this
// file instead of bun:ffi, so backends can keep the same call sites.

// Runtime pointers are numbers in Bun and bigints in Node's experimental FFI.
// Keep both in the our own type, and narrow only inside a backend that requires
// it.
export type Pointer = (number | bigint) & { readonly [pointerBrand]: "Pointer" }

// Bun accepts numeric pointers only. Keep this type private so Bun's pointer
// model does not leak into the exported surface.
type BunPointer = number

// These names match the FFI type strings used today. Backends map them at
// library load time instead of wrapping every native call.
export const FFIType = {
  char: "char",
  int8_t: "int8_t",
  i8: "i8",
  uint8_t: "uint8_t",
  u8: "u8",
  int16_t: "int16_t",
  i16: "i16",
  uint16_t: "uint16_t",
  u16: "u16",
  int32_t: "int32_t",
  i32: "i32",
  int: "int",
  uint32_t: "uint32_t",
  u32: "u32",
  int64_t: "int64_t",
  i64: "i64",
  uint64_t: "uint64_t",
  u64: "u64",
  double: "double",
  f64: "f64",
  float: "float",
  f32: "f32",
  bool: "bool",
  ptr: "ptr",
  pointer: "pointer",
  void: "void",
  cstring: "cstring",
  function: "function",
  usize: "usize",
  callback: "callback",
  napi_env: "napi_env",
  napi_value: "napi_value",
  buffer: "buffer",
} as const

export type FFIType = (typeof FFIType)[keyof typeof FFIType]
export type FFITypeOrString = FFIType

// A function definition describes one native symbol. `ptr` overrides the symbol
// address and follows the same pointer safety rules as normal pointer values.
export interface FFIFunction {
  readonly args?: readonly FFITypeOrString[]
  readonly returns?: FFITypeOrString
  readonly ptr?: Pointer
  readonly threadsafe?: boolean
}

// A callback instance owns a native trampoline. `close()` invalidates `ptr`;
// callers must not pass that pointer to native code after close.
export interface FFICallbackInstance {
  readonly ptr: Pointer | null
  readonly threadsafe: boolean
  close(): void
}

// A loaded library owns callbacks created through `createCallback()`.
//
// Typical use:
// const callback = library.createCallback(handler, { args: ["ptr"], returns: "void" })
// library.symbols.setLogCallback(callback.ptr)
//
// `close()` first closes the native library, then closes any callbacks that
// remain open.
export interface Library<Fns extends Record<string, FFIFunction>> {
  symbols: { [K in keyof Fns]: (...args: any[]) => any }
  createCallback(callback: (...args: any[]) => any, definition: FFIFunction): FFICallbackInstance
  close(): void
}

// A backend normalizes runtime differences once. Do not wrap hot symbol calls
// here unless a backend must adapt them.
interface FfiBackend {
  dlopen<Fns extends Record<string, FFIFunction>>(path: string | URL, symbols: Fns): Library<Fns>
  ptr(value: ArrayBufferLike | ArrayBufferView): Pointer
  suffix: string
  toArrayBuffer(pointer: Pointer, offset: number | undefined, length: number): ArrayBuffer
}

interface BunFFIFunction {
  readonly args?: readonly FFITypeOrString[]
  readonly returns?: FFITypeOrString
  readonly ptr?: BunPointer
  readonly threadsafe?: boolean
}

interface BunFfiLibrary<Fns extends Record<string, BunFFIFunction>> {
  symbols: { [K in keyof Fns]: (...args: any[]) => any }
  close(): void
}

interface BunFfiBackend {
  JSCallback: new (callback: (...args: any[]) => any, definition: BunFFIFunction) => FFICallbackInstance
  dlopen<Fns extends Record<string, BunFFIFunction>>(path: string | URL, symbols: Fns): BunFfiLibrary<Fns>
  ptr(value: ArrayBufferLike | ArrayBufferView): Pointer
  suffix: string
  toArrayBuffer(pointer: BunPointer, offset: number | undefined, length: number): ArrayBuffer
}

const FFI_UNAVAILABLE = "OpenTUI native FFI is not available for this runtime yet."
const LIBRARY_CLOSED = "Cannot create FFI callback after library.close() has been called."
const POINTER_NEGATIVE = "Pointer must be non-negative"
const POINTER_UNSAFE = "Pointer exceeds safe integer range"

function unavailable(): never {
  throw new Error(FFI_UNAVAILABLE)
}

// The placeholder backend lets non-Bun runtimes load without errors.
const unsupportedBackend: FfiBackend = {
  dlopen() {
    return unavailable()
  },
  ptr() {
    return unavailable()
  },
  suffix: "",
  toArrayBuffer() {
    return unavailable()
  },
}

const isBun =
  typeof process !== "undefined" &&
  typeof process.versions === "object" &&
  process.versions !== null &&
  typeof process.versions.bun === "string"

// Keep the Bun module import behind the runtime check so Node does not resolve
// bun:ffi during import.
const backend = isBun ? createBunBackend(await importModule<BunFfiBackend>("bun:ffi")) : unsupportedBackend

function importModule<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>
}

// Convert pointer values for current Bun-backed call sites that still store
// numeric pointers.
//
// TODO: Remove this temporary shim once current Bun FFI call sites use the
// platform backend. Do not use this helper to force future Node pointers into
// numbers.
export function toPointer(value: number | bigint): Pointer {
  if (typeof value === "bigint") {
    return toSafeNumberPointer(value) as Pointer
  }

  return value as Pointer
}

// Convert a bigint pointer to a number only when JavaScript can represent it
// exactly. A rounded pointer would target the wrong address.
function toSafeNumberPointer(pointer: bigint): number {
  if (pointer < 0n) {
    throw new Error(POINTER_NEGATIVE)
  }

  if (pointer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(POINTER_UNSAFE)
  }

  return Number(pointer)
}

// Wrap a backend callback so the loaded library can close it later. The wrapper
// keeps `ptr` live until close, then clears it so callers cannot reuse a stale
// trampoline pointer.
function createManagedCallback(raw: FFICallbackInstance, callbacks: Set<FFICallbackInstance>): FFICallbackInstance {
  let ptr = raw.ptr
  let closed = false

  const instance: FFICallbackInstance = {
    get ptr() {
      return ptr
    },
    get threadsafe() {
      return raw.threadsafe
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      callbacks.delete(instance)
      try {
        raw.close()
      } finally {
        // Clear the pointer even if the backend close throws. The trampoline is
        // no longer safe to use.
        ptr = null
      }
    },
  }

  callbacks.add(instance)

  return instance
}

function normalizeBunDefinitions<Fns extends Record<string, FFIFunction>>(
  definitions: Fns,
): { [K in keyof Fns]: BunFFIFunction } {
  // Normalize all Bun definitions before `dlopen()`. Bun rejects bigint pointer
  // overrides, so convert them once before loading the native library.
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [name, normalizeBunDefinition(definition)]),
  ) as { [K in keyof Fns]: BunFFIFunction }
}

function normalizeBunDefinition(definition: FFIFunction): BunFFIFunction {
  return {
    args: definition.args,
    returns: definition.returns,
    ptr: definition.ptr == null ? undefined : toBunPointer(definition.ptr),
    threadsafe: definition.threadsafe,
  }
}

// Convert Pointer pointers to Bun pointers at the Bun boundary only.
function toBunPointer(pointer: Pointer): BunPointer {
  return typeof pointer === "bigint" ? toSafeNumberPointer(pointer) : pointer
}

// Create a Bun backend from bun:ffi.
export function createBunBackend(bun: BunFfiBackend): FfiBackend {
  return {
    dlopen(path, symbols) {
      const library = bun.dlopen(path, normalizeBunDefinitions(symbols))
      const callbacks = new Set<FFICallbackInstance>()
      let closed = false

      return {
        symbols: library.symbols,
        createCallback(callback, definition) {
          if (closed) {
            // A closed library no longer owns native state. New callbacks would
            // have no cleanup path.
            throw new Error(LIBRARY_CLOSED)
          }

          // Bun callbacks are standalone objects. OpenTUI treats them as
          // library-owned to match the future Node FFI shape and to avoid
          // leaked trampolines.
          const raw = new bun.JSCallback(callback, normalizeBunDefinition(definition))

          return createManagedCallback(raw, callbacks)
        },
        close() {
          if (closed) {
            return
          }

          closed = true

          try {
            // Close native state while callbacks still point to live
            // trampolines. Native teardown may call back during final cleanup.
            library.close()
          } finally {
            // After native teardown, close any JS trampolines the caller did
            // not close explicitly.
            for (const callback of [...callbacks]) {
              callback.close()
            }
          }
        },
      }
    },
    ptr: bun.ptr,
    suffix: bun.suffix,
    toArrayBuffer(pointer, offset, length) {
      // Bun only accepts numeric pointers here. Keep the coercion at this
      // backend boundary.
      return bun.toArrayBuffer(toBunPointer(pointer), offset, length)
    },
  }
}

export const dlopen = backend.dlopen
export const ptr = backend.ptr
export const suffix = backend.suffix
export const toArrayBuffer = backend.toArrayBuffer
