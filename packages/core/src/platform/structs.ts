type StructDefinition = readonly unknown[]

export interface StructDescriptor<TOutput = unknown, TInput = TOutput> {
  readonly size: number
  pack(value: TInput): ArrayBuffer
  packList(values: readonly TInput[]): ArrayBuffer
  unpack(buffer: ArrayBuffer | SharedArrayBuffer): TOutput
  unpackList(buffer: ArrayBuffer | SharedArrayBuffer, count: number): TOutput[]
}

interface StructBackend {
  defineStruct<TOutput = unknown, TInput = TOutput>(
    definition: StructDefinition,
    options?: unknown,
  ): StructDescriptor<TOutput, TInput>
  defineEnum<T extends Record<string, number>>(definition: T, base?: unknown): T
}

const STRUCTS_UNAVAILABLE = "OpenTUI native struct packing is not available for this runtime yet."

function unavailable(): never {
  throw new Error(STRUCTS_UNAVAILABLE)
}

const unsupportedBackend: StructBackend = {
  defineStruct() {
    return {
      size: 0,
      pack() {
        return unavailable()
      },
      packList() {
        return unavailable()
      },
      unpack() {
        return unavailable()
      },
      unpackList() {
        return unavailable()
      },
    }
  },
  defineEnum(definition) {
    return definition
  },
}

const isBun =
  typeof process !== "undefined" &&
  typeof process.versions === "object" &&
  process.versions !== null &&
  typeof process.versions.bun === "string"
const backend = isBun ? await importModule<StructBackend>("bun-ffi-structs") : unsupportedBackend

function importModule<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>
}

export const defineStruct = backend.defineStruct
export const defineEnum = backend.defineEnum
