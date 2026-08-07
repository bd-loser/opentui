import { resolveBundledDefaultParserAsset } from "../lib/tree-sitter/default-parser-assets.bun.js"
import { getCurrentNodeAssetTarget, getNativeAssetDescriptor } from "../node-asset-target.js"
import { resolveAndroidNativeLibraryPath } from "./android-native.js"
import { resolveAssetPath, resolveAssetRootPath } from "./assets.js"
import { resolveBundledFilePath } from "./runtime.js"

interface NativePackageModule {
  readonly default: string
}

const CORE_ASSET_PREFIX = "@opentui/core/"
const PARSER_WORKER_ASSET_KEY = `${CORE_ASSET_PREFIX}parser.worker.js`
const TREE_SITTER_WASM_ASSET_KEY = "web-tree-sitter/tree-sitter.wasm"

const bundledTreeSitterWorkerPath = await resolveBundledFilePath(
  PARSER_WORKER_ASSET_KEY,
  () => import("@opentui/core/parser.worker" as string, { with: { type: "file" } }),
  new URL("../lib/tree-sitter/parser.worker.js", import.meta.url),
  import.meta.url,
  { useAssetRoot: false },
)

export function resolveDefaultParserAsset(relativePath: string, fallbackPath: URL): Promise<string> {
  return resolveBundledDefaultParserAsset(relativePath, fallbackPath)
}

export function resolveDefaultTreeSitterWorkerPath(_fallbackPath: URL): string {
  return resolveAssetPath(PARSER_WORKER_ASSET_KEY, bundledTreeSitterWorkerPath)
}

export function resolveTreeSitterWasm(): Promise<string> {
  return resolveBundledFilePath(
    TREE_SITTER_WASM_ASSET_KEY,
    () => import("web-tree-sitter/tree-sitter.wasm" as string, { with: { type: "wasm" } }),
    () => import.meta.resolve(TREE_SITTER_WASM_ASSET_KEY),
    import.meta.url,
  )
}

export async function resolveNativeLibraryPath(): Promise<string> {
  const target = getCurrentNodeAssetTarget()
  const asset = getNativeAssetDescriptor(target)
  const configuredPath = resolveAssetRootPath(asset.key)
  if (configuredPath !== undefined) {
    return configuredPath
  }

  // ── XINCLI: Android/Termux ────────────────────────────────────────────
  if (target.platform === "android") {
    const androidPath = await resolveAndroidNativeLibraryPath(asset.packageName, target.arch)
    if (androidPath !== undefined) {
      return androidPath
    }
    throw new Error(
      `OpenTUI native library for Android is missing. Install ${asset.packageName}, ` +
        `or build it on-device with: bash packages/core/scripts/build-native-termux.sh`,
    )
  }

  if (process.platform === "darwin") {
    if (process.arch === "x64") {
      return ((await import("@opentui/core-darwin-x64" as string)) as NativePackageModule).default
    }
    if (process.arch === "arm64") {
      return ((await import("@opentui/core-darwin-arm64" as string)) as NativePackageModule).default
    }
  }

  if (process.platform === "linux") {
    if (process.arch === "x64") {
      if (process.env.OPENTUI_LIBC === "musl") {
        return ((await import("@opentui/core-linux-x64-musl" as string)) as NativePackageModule).default
      }
      return ((await import("@opentui/core-linux-x64" as string)) as NativePackageModule).default
    }

    if (process.arch === "arm64") {
      if (process.env.OPENTUI_LIBC === "musl") {
        return ((await import("@opentui/core-linux-arm64-musl" as string)) as NativePackageModule).default
      }
      return ((await import("@opentui/core-linux-arm64" as string)) as NativePackageModule).default
    }
  }

  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return ((await import("@opentui/core-win32-x64" as string)) as NativePackageModule).default
    }
    if (process.arch === "arm64") {
      return ((await import("@opentui/core-win32-arm64" as string)) as NativePackageModule).default
    }
  }

  throw new Error(`OpenTUI is not supported on the current platform: ${asset.packageName}`)
}
