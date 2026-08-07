// ═════════════════════════════════════════════════════════════════════
// XINCLI: Android/Termux native library resolution
//
// Additive file — upstream has no equivalent, so this never conflicts
// when rebasing the fork onto a new upstream tag. The modified upstream
// files only gain a small call into here.
//
// Resolution order on Termux:
//   1. packages/core/prebuilt/<arch>/libopentui.so — only ever present in
//      a source checkout, never in a published tarball (build.ts does not
//      copy prebuilt/ into dist/). In a checkout this is the .so you just
//      built with build-native-termux.sh, so it must win: otherwise a
//      stale @xincli/opentui-core-android-arm64 sitting in node_modules
//      would silently shadow the build you are trying to test.
//   2. @xincli/opentui-core-android-<arch> — the published npm package,
//      which is what real consumers get.
//
// OTUI_ASSET_ROOT overrides both (handled upstream, before we get here).
//
// Caveat: a checkout whose committed prebuilt .so predates the current
// source can mismatch the FFI ABI. Rebuild it after changing upstream
// versions — that is what the xin-patch flow does.
// ═════════════════════════════════════════════════════════════════════

import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

interface NativePackageModule {
  readonly default: string
}

/** Maps a Node arch to the prebuilt directory name used by the Zig build. */
const PREBUILT_DIR_BY_ARCH: Record<string, string> = {
  arm64: "aarch64-android",
  arm: "arm-android",
  x64: "x86_64-android",
}

/**
 * Resolves the Android native library path, or returns undefined when
 * neither a local prebuilt .so nor the npm package is present. Callers
 * fall through to their normal error path in that case.
 */
export async function resolveAndroidNativeLibraryPath(
  packageName: string,
  arch: string = process.arch,
): Promise<string | undefined> {
  // 1. Source checkout: the freshly built .so.
  const dirName = PREBUILT_DIR_BY_ARCH[arch]
  if (dirName !== undefined) {
    const prebuilt = fileURLToPath(new URL(`../../prebuilt/${dirName}/libopentui.so`, import.meta.url))
    if (existsSync(prebuilt)) {
      return prebuilt
    }
  }

  // 2. Published npm package.
  try {
    const mod = (await import(packageName as string)) as NativePackageModule
    if (typeof mod.default === "string" && mod.default.length > 0) {
      return mod.default
    }
  } catch {
    // Not installed.
  }

  return undefined
}
