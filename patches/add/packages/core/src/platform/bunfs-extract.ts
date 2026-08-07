// ═════════════════════════════════════════════════════════════════════
// XINCLI: extract the native library out of bunfs
//
// Additive file — keeps the change inside zig.ts down to a single call,
// so rebasing the fork onto a new upstream tag stays trivial.
//
// When opentui is bundled into a `bun build --compile` binary, the .so
// lives inside bunfs (Bun's virtual embedded filesystem) at a path like
// /$bunfs/root/libopentui.so.
//
// Two separate reasons the upstream path rewrite is not enough:
//   1. fs.readFileSync() CANNOT read bunfs — it hands the path to the
//      kernel, which knows nothing about bunfs, giving ENOENT. Only
//      Bun.file() works, because Bun intercepts that read.
//   2. dlopen() is a raw kernel syscall, so it cannot read bunfs either.
//
// So the bytes have to be copied out to a real file before dlopen(). The
// hash in the filename keeps different opentui versions from colliding,
// and the extracted file is reused across runs.
// ═════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface BunFileAPI {
  file: (path: string) => { arrayBuffer: () => Promise<ArrayBuffer> }
}

/**
 * Copies a bunfs-embedded native library to a real temp file and returns
 * that path. Safe to call only when isBunfsPath(bunfsPath) is true.
 */
export async function extractBunfsNativeLibrary(bunfsPath: string): Promise<string> {
  const extractDir = join(tmpdir(), "opentui-native")
  const hash = createHash("sha256").update(bunfsPath).digest("hex").slice(0, 16)
  const extracted = join(extractDir, `libopentui-${hash}.so`)

  if (existsSync(extracted)) {
    return extracted
  }

  mkdirSync(extractDir, { recursive: true })

  try {
    const bun = (globalThis as { Bun?: BunFileAPI }).Bun
    if (bun !== undefined && typeof bun.file === "function") {
      const bytes = await bun.file(bunfsPath).arrayBuffer()
      writeFileSync(extracted, new Uint8Array(bytes), { mode: 0o755 })
    } else {
      // Node cannot reach bunfs, but a non-bunfs path that merely looks
      // like one would still be readable here. Last-resort fallback.
      writeFileSync(extracted, readFileSync(bunfsPath), { mode: 0o755 })
    }
  } catch (error) {
    throw new Error(
      `OpenTUI failed to extract its native library from ${JSON.stringify(bunfsPath)} ` +
        `to ${JSON.stringify(extracted)}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  return extracted
}
