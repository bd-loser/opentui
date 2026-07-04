// build-android.ts — Cross-compile opentui native core for Android/Termux.
//
// Invokes Zig with the Android NDK sysroot so the resulting .so links
// against Bionic libc (not glibc/musl). The NDK must be installed and
// ANDROID_NDK_HOME must point at it.
//
// Produces three .so files:
//   aarch64-android/libopentui.so  → @xincli/opentui-core-android-arm64
//   arm-android/libopentui.so      → @xincli/opentui-core-android-arm
//   x86_64-android/libopentui.so   → @xincli/opentui-core-android-x64
//
// Each gets packaged into its own npm subdirectory under dist-android/.

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")

const NDK_HOME = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT
if (!NDK_HOME) {
  console.error("Error: ANDROID_NDK_HOME (or ANDROID_NDK_ROOT) must be set")
  console.error("Install the NDK and export ANDROID_NDK_HOME=/path/to/ndk")
  process.exit(1)
}

const ZIG_VERSION = "0.15.2"
const NDK_API_LEVEL = process.env.ANDROID_API_LEVEL ?? "24" // Android 7.0+ — covers 99% of Termux users

type AndroidArch = {
  zigArch: string
  ndkTriple: string
  outputName: string
  packageName: string
}

const ANDROID_ARCHES: AndroidArch[] = [
  {
    zigArch: "aarch64",
    ndkTriple: "aarch64-linux-android",
    outputName: "aarch64-android",
    packageName: "@xincli/opentui-core-android-arm64",
  },
  {
    zigArch: "arm",
    ndkTriple: "armv7a-linux-androideabi",
    outputName: "arm-android",
    packageName: "@xincli/opentui-core-android-arm",
  },
  {
    zigArch: "x86_64",
    ndkTriple: "x86_64-linux-android",
    outputName: "x86_64-android",
    packageName: "@xincli/opentui-core-android-x64",
  },
]

function run(cmd: string, args: string[], cwd: string, label: string): void {
  console.log(`▶ ${label}`)
  console.log(`  ${cmd} ${args.join(" ")}`)
  const result: SpawnSyncReturns<Buffer> = spawnSync(cmd, args, { cwd, stdio: "inherit" })
  if (result.error || result.status !== 0) {
    console.error(`✗ ${label} failed`)
    process.exit(1)
  }
  console.log(`✓ ${label}`)
}

function buildSysrootPath(arch: AndroidArch): string {
  // NDK sysroot layout: $NDK_HOME/toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/<triple>/<api>/
  // The host prebuilt dir varies by runner OS — we glob for it.
  const fs = require("fs") as typeof import("fs")
  const prebuiltDir = join(NDK_HOME, "toolchains", "llvm", "prebuilt")
  const hosts = fs.readdirSync(prebuiltDir)
  if (hosts.length === 0) {
    console.error(`Error: no prebuilt dir found in ${prebuiltDir}`)
    process.exit(1)
  }
  const host = hosts[0]!
  return join(prebuiltDir, host, "sysroot")
}

function buildOneArch(arch: AndroidArch): void {
  console.log(`\n═══ Building ${arch.packageName} ═══`)
  const sysroot = buildSysrootPath(arch)
  const zigTarget = `${arch.zigArch}-linux-android`

  // Zig cross-compile with NDK sysroot. --system-libc makes Zig use the
  // NDK's Bionic libc headers/libs instead of trying to find glibc.
  const zigArgs = [
    "build",
    "-Dtarget=" + zigTarget,
    `-fsystem-libc`,
    `--sysroot=${sysroot}`,
    `-Doptimize=ReleaseFast`,
    "-Dlib-only", // only build the shared lib, not executables
  ]

  // First build the native .so via Zig directly (bypassing build.ts which
  // doesn't know about android sysroots)
  run("zig", zigArgs, join(rootDir, "src", "zig"), `Zig build ${zigTarget}`)

  // Locate the produced .so and copy it into the package dir
  const srcSo = join(rootDir, "src", "zig", "zig-out", "lib", "libopentui.so")
  if (!existsSync(srcSo)) {
    // Zig may put it under a different path depending on version — search.
    console.error(`✗ libopentui.so not found at ${srcSo}`)
    console.error("  Check zig-out/ for the actual output location")
    process.exit(1)
  }

  // Create the npm package structure
  const pkgDir = join(rootDir, "dist-android", arch.packageName)
  mkdirSync(pkgDir, { recursive: true })
  copyFileSync(srcSo, join(pkgDir, "libopentui.so"))

  // Write package.json for this variant
  const pkgJson = {
    name: arch.packageName,
    version: "0.4.3",
    description: `OpenTUI native core for Android ${arch.zigArch} (Termux). Cross-compiled by XINCLI.`,
    repository: {
      type: "git",
      url: "git+https://github.com/bd-loser/opentui.git",
    },
    license: "MIT",
    main: "libopentui.so",
    files: ["libopentui.so"],
  }
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2))

  console.log(`✓ Packaged ${arch.packageName} → ${pkgDir}`)
}

// Build all three arches
for (const arch of ANDROID_ARCHES) {
  buildOneArch(arch)
}

console.log("\n✅ All Android variants built successfully")
console.log("   dist-android/@xincli/opentui-core-android-arm64/libopentui.so")
console.log("   dist-android/@xincli/opentui-core-android-arm/libopentui.so")
console.log("   dist-android/@xincli/opentui-core-android-x64/libopentui.so")
