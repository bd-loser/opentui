import { fstatSync } from "node:fs"
import tty from "node:tty"
import { dlopen, FFIType, ptr } from "bun:ffi"

const F_GETFL = 3
const F_SETFL = 4
const O_NONBLOCK = process.platform === "darwin" ? 0x0004 : 0x0800

type TtyReadStream = tty.ReadStream & {
  fd: number
  setRawMode?: (mode: boolean) => unknown
}

function libcPath(): string {
  if (process.platform === "darwin") return "libc.dylib"
  return "libc.so.6"
}

function openptyPath(): string {
  if (process.platform === "darwin") return "libc.dylib"
  return "libutil.so.1"
}

const libc = dlopen(libcPath(), {
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})

const libpty = dlopen(openptyPath(), {
  openpty: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
})

function fdState(fd: number): string {
  try {
    const stat = fstatSync(fd)
    return `open mode=${stat.mode}`
  } catch (error) {
    return `closed error=${error instanceof Error ? error.message : String(error)}`
  }
}

function tryRaw(stream: TtyReadStream, label: string): void {
  let emitted: unknown
  const onError = (error: unknown) => {
    emitted = error
    console.log(`${label}: error event:`, error instanceof Error ? error.message : String(error))
  }

  stream.once("error", onError)
  try {
    stream.setRawMode?.(true)
    console.log(`${label}: setRawMode returned; emitted=${emitted ? "yes" : "no"}; fd=${fdState(stream.fd)}`)
  } catch (error) {
    console.log(`${label}: setRawMode threw:`, error instanceof Error ? error.message : String(error), `fd=${fdState(stream.fd)}`)
  } finally {
    stream.off("error", onError)
  }
}

const invalidBefore = new tty.ReadStream(9999) as TtyReadStream
console.log("raw-mode symptom on invalid fd", {
  fd: invalidBefore.fd,
  isTTY: invalidBefore.isTTY,
  fdState: fdState(invalidBefore.fd),
})
tryRaw(invalidBefore, "invalid-fd-before")

const master = new Int32Array(1)
const slave = new Int32Array(1)
const openResult = libpty.symbols.openpty(ptr(master), ptr(slave), null, null, null)
if (openResult !== 0) throw new Error(`openpty failed: ${openResult}`)

const masterFd = master[0]!
const slaveFd = slave[0]!
console.log("opened", { masterFd, slaveFd, master: fdState(masterFd), slave: fdState(slaveFd) })

const flags = libc.symbols.fcntl(masterFd, F_GETFL, 0)
if (flags < 0) throw new Error(`fcntl(F_GETFL) failed: ${flags}`)
const setFlags = libc.symbols.fcntl(masterFd, F_SETFL, flags | O_NONBLOCK)
if (setFlags < 0) throw new Error(`fcntl(F_SETFL, O_NONBLOCK) failed: ${setFlags}`)
console.log("nonblock set", { flags, next: flags | O_NONBLOCK })

const stream = new tty.ReadStream(masterFd) as TtyReadStream
console.log("stream created", { fd: stream.fd, isTTY: stream.isTTY, readable: stream.readable, destroyed: stream.destroyed })
tryRaw(stream, "before-read")

let triedRawAfterReadError = false
stream.on("data", (chunk) => console.log("data", chunk.length))
stream.on("error", (error) => {
  console.log("persistent error:", error instanceof Error ? error.message : String(error), { fd: fdState(masterFd), streamFd: stream.fd })
  if (!triedRawAfterReadError) {
    triedRawAfterReadError = true
    tryRaw(stream, "during-read-error")
  }
})
stream.on("end", () => console.log("end", { fd: fdState(masterFd), destroyed: stream.destroyed }))
stream.on("close", () => console.log("close", { fd: fdState(masterFd), destroyed: stream.destroyed }))

stream.resume()

for (let i = 0; i < 200; i++) {
  await Bun.sleep(10)
  if (i % 10 === 0) {
    console.log("probe", { i, fd: fdState(masterFd), readable: stream.readable, destroyed: stream.destroyed })
  }

  if (fdState(masterFd).startsWith("closed") || stream.destroyed) break
}

console.log("after-read", { fd: fdState(masterFd), readable: stream.readable, destroyed: stream.destroyed })
tryRaw(stream, "after-read")

libc.symbols.close(slaveFd)
if (!fdState(masterFd).startsWith("closed")) libc.symbols.close(masterFd)
