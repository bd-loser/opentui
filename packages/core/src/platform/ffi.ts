declare const pointerBrand: unique symbol

export type Pointer = (number | bigint) & { readonly [pointerBrand]: "Pointer" }

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

export interface FFIFunction {
  readonly args?: readonly FFITypeOrString[]
  readonly returns?: FFITypeOrString
  readonly ptr?: Pointer
  readonly threadsafe?: boolean
}

export interface FFICallbackInstance {
  readonly ptr: Pointer | null
  readonly threadsafe: boolean
  close(): void
}

export interface Library<Fns extends Record<string, FFIFunction>> {
  symbols: { [K in keyof Fns]: (...args: any[]) => any }
  createCallback(callback: (...args: any[]) => any, definition: FFIFunction): FFICallbackInstance
  close(): void
}

interface FfiBackend {
  dlopen<Fns extends Record<string, FFIFunction>>(path: string | URL, symbols: Fns): Library<Fns>
  ptr(value: ArrayBufferLike | ArrayBufferView): Pointer
  suffix: string
  toArrayBuffer(pointer: Pointer, offset: number | undefined, length: number): ArrayBuffer
}

interface BunFfiLibrary<Fns extends Record<string, FFIFunction>> {
  symbols: { [K in keyof Fns]: (...args: any[]) => any }
  close(): void
}

interface BunFfiBackend {
  JSCallback: new (callback: (...args: any[]) => any, definition: FFIFunction) => FFICallbackInstance
  dlopen<Fns extends Record<string, FFIFunction>>(path: string | URL, symbols: Fns): BunFfiLibrary<Fns>
  ptr(value: ArrayBufferLike | ArrayBufferView): Pointer
  suffix: string
  toArrayBuffer(pointer: Pointer, offset: number | undefined, length: number): ArrayBuffer
}

const FFI_UNAVAILABLE = "OpenTUI native FFI is not available for this runtime yet."

function unavailable(): never {
  throw new Error(FFI_UNAVAILABLE)
}

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
const backend = isBun ? createBunBackend(await importModule<BunFfiBackend>("bun:ffi")) : unsupportedBackend

function importModule<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>
}

function createBunBackend(bun: BunFfiBackend): FfiBackend {
  return {
    dlopen(path, symbols) {
      const library = bun.dlopen(path, symbols)

      return {
        symbols: library.symbols,
        createCallback(callback, definition) {
          return new bun.JSCallback(callback, definition)
        },
        close() {
          library.close()
        },
      }
    },
    ptr: bun.ptr,
    suffix: bun.suffix,
    toArrayBuffer: bun.toArrayBuffer,
  }
}

export const dlopen = backend.dlopen
export const ptr = backend.ptr
export const suffix = backend.suffix
export const toArrayBuffer = backend.toArrayBuffer
