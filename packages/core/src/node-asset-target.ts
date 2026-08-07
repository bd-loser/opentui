export type NodeAssetTarget = {
  // ── XINCLI: "android" covers Termux on-device builds ────────────────
  readonly platform: "darwin" | "linux" | "win32" | "android"
  readonly arch: "arm64" | "x64"
  readonly libc?: "glibc" | "musl"
}

export interface NativeAssetDescriptor {
  readonly key: string
  readonly packageName: string
  readonly fileName: string
}

const NATIVE_FILE_NAMES = {
  darwin: "libopentui.dylib",
  linux: "libopentui.so",
  win32: "opentui.dll",
  // ── XINCLI: Android/Termux — Bionic ELF, same extension as linux ────
  android: "libopentui.so",
} as const

// ── XINCLI: Android natives ship under the @xincli scope ──────────────
// Upstream does not publish an Android native package, so the fork
// builds it on-device (packages/core/scripts/build-native-termux.sh) and
// publishes it as @xincli/opentui-core-android-arm64.
const XINCLI_ANDROID_SCOPE = "@xincli/opentui-core-android"

// Termux under Bun reports process.platform === "linux" (Bun normalizes
// android→linux); under Node it reports "android". $PREFIX is the reliable
// discriminator — Termux always sets it to a path under com.termux.
export function isTermuxRuntime(): boolean {
  return typeof process.env.PREFIX === "string" && process.env.PREFIX.includes("com.termux")
}

export function getNativeAssetDescriptor(target: NodeAssetTarget): NativeAssetDescriptor {
  if (!Object.hasOwn(NATIVE_FILE_NAMES, target.platform) || (target.arch !== "arm64" && target.arch !== "x64")) {
    throw new Error(`Unsupported OpenTUI Node asset target: ${String(target.platform)}-${String(target.arch)}`)
  }

  if (target.libc !== undefined && target.libc !== "glibc" && target.libc !== "musl") {
    throw new Error(`Unsupported libc for OpenTUI Node assets: ${String(target.libc)}`)
  }
  if (target.platform !== "linux" && target.libc !== undefined) {
    throw new Error(`OpenTUI Node asset target libc is only supported on Linux, got ${target.platform}`)
  }

  const libcSuffix = target.platform === "linux" && target.libc === "musl" ? "-musl" : ""
  // ── XINCLI: Android natives come from @xincli, not @opentui ──────────
  const packageName =
    target.platform === "android"
      ? `${XINCLI_ANDROID_SCOPE}-${target.arch}`
      : `@opentui/core-${target.platform}-${target.arch}${libcSuffix}`
  const fileName = NATIVE_FILE_NAMES[target.platform]
  return {
    key: `${packageName}/${fileName}`,
    packageName,
    fileName,
  }
}

export function getCurrentNodeAssetTarget(): NodeAssetTarget {
  const libc = process.env.OPENTUI_LIBC

  // ── XINCLI: detect Termux before the libc check ──────────────────────
  // Bionic is neither glibc nor musl, so OPENTUI_LIBC does not apply and
  // the linux libc validation below must not run for it.
  if (process.platform === "android" || (process.platform === "linux" && isTermuxRuntime())) {
    return {
      platform: "android",
      arch: process.arch as NodeAssetTarget["arch"],
    }
  }

  if (process.platform === "linux" && libc !== undefined && libc !== "" && libc !== "glibc" && libc !== "musl") {
    throw new Error(`On Linux, OPENTUI_LIBC must be unset, empty, "glibc", or "musl", got ${JSON.stringify(libc)}`)
  }

  return {
    platform: process.platform as NodeAssetTarget["platform"],
    arch: process.arch as NodeAssetTarget["arch"],
    ...(process.platform === "linux" && libc === "musl" ? { libc } : {}),
  }
}
