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
  //
  // The specifier here MUST stay a string LITERAL. Bun's `--compile`
  // bundler only follows static specifiers; handed a computed one it
  // embeds nothing at all, and the standalone binary then has no .so to
  // find — neither path above survives compilation, because there is no
  // node_modules beside the binary and no source checkout either:
  //
  //   Failed to initialize OpenTUI render library: OpenTUI native library
  //   for Android is missing. Install @xincli/opentui-core-android-arm64
  //
  // 0.4.10 worked for exactly this reason: it had
  // `await import("@opentui/core-android-arm64")` written out in
  // zig.ts, so Bun resolved it at build time, embedded libopentui.so into
  // bunfs, and extractBunfsNativeLibrary() copied it out to a real file
  // for dlopen(). Passing `packageName` through as a variable — as the
  // 0.5.1 port did — silently removed the embed and left the extractor
  // with nothing to extract.
  //
  // The name is upstream's, not @xincli's, even though the fork is what
  // publishes the tarball. core declares it as an ALIAS:
  //
  //   "@opentui/core-android-arm64":
  //       "npm:@xincli/opentui-core-android-arm64@<version>"
  //
  // which installs the fork's package into node_modules under upstream's
  // name — so this literal resolves, and it is the name build.ts already
  // derives for the android variant. Importing the @xincli name directly
  // would NOT resolve, because the alias never creates that directory.
  //
  // Aliasing is also what makes the fork's own npm hygiene possible: npm
  // indexes dependents by the dependency KEY, so a literal @xincli key
  // here marks the native package as having dependents forever, and
  // npm then refuses to unpublish ANY version of it —
  //   405 ... Failed criteria: has dependent packages in the registry
  // which is how four broken 0.5.x builds got stuck on the registry.
  //
  // arm64 is the only Android arch the fork publishes, so a single
  // literal covers every real consumer. Other arches keep the computed
  // import: still correct for an ordinary node_modules install, just not
  // embeddable into a compiled binary.
  if (arch === "arm64") {
    try {
      const mod = (await import("@opentui/core-android-arm64" as string)) as NativePackageModule
      if (typeof mod.default === "string" && mod.default.length > 0) {
        return mod.default
      }
    } catch {
      // Not installed.
    }
  }

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
