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

  // Zig's build system: -Dtarget sets the target, -Doptimize sets the
  // optimization mode. The NDK sysroot is passed via ZIG_* env vars that
  // Zig's build system respects for cross-compilation. We can't pass
  // --sysroot directly to `zig build` — it's a compiler flag, not a
  // build-system flag. Instead we set CFLAGS/LDFLAGS that Zig's
  // linkSystemLibrary picks up, AND set the NDK toolchain in PATH so Zig
  // can find the android linker (ld.lld from the NDK).
  const prebuiltDir = join(NDK_HOME, "toolchains", "llvm", "prebuilt")
  const fs = require("fs") as typeof import("fs")
  const hosts = fs.readdirSync(prebuiltDir)
  const host = hosts[0]!
  const ndkToolchainBin = join(prebuiltDir, host, "bin")

  // ── Zig + Android NDK cross-compilation ────────────────────────────
  //
  // The core challenge: Zig doesn't bundle Android's Bionic libc. So we
  // MUST tell Zig to use the NDK's libc instead. There are two pieces:
  //
  //   1. Pass --sysroot=<NDK sysroot> to EVERY Zig compiler/linker invocation.
  //      We do this via ZIG_GLOBAL_ARGS env var (Zig 0.15 reads this).
  //
  //   2. Add the NDK's lib paths so linkSystemLibrary("OpenSLES") works.
  //      We do this via XINCLI_ANDROID_LIB_PATH env var (read by build.zig).
  //
  //   3. Set CC/CXX to the NDK's clang wrappers so any C compilation (yoga,
  //      miniaudio_shim) uses NDK headers + libs.
  const sysrootLibApiSpecific = join(sysroot, "usr", "lib", arch.ndkTriple, NDK_API_LEVEL)
  const sysrootLibGeneric = join(sysroot, "usr", "lib", arch.ndkTriple)
  const sysrootInclude = join(sysroot, "usr", "include")
  // Arch-specific include dir — the NDK puts <asm/> headers here, and
  // <linux/types.h> does #include <asm/types.h>. Without this path, Zig's
  // C import fails with 'asm/types.h' file not found.
  const sysrootIncludeArch = join(sysroot, "usr", "include", arch.ndkTriple)

  // ── Zig libc file ───────────────────────────────────────────────────
  // Zig 0.15 needs an explicit libc file to cross-compile against a
  // non-bundled libc like Android's Bionic. The file tells Zig where to
  // find include dirs, crt objects, and the libc.so. Without this, Zig
  // fails with 'unable to provide libc for target aarch64-linux-android'.
  const libcFileContent = [
    `include_dir=${sysrootInclude}`,
    `sys_include_dir=${sysrootInclude}`,
    `crt_dir=${sysrootLibApiSpecific}`,
    `msvc_lib_dir=`,
    `kernel32_lib_dir=`,
    `gcc_dir=`,
  ].join('\n')
  const libcFilePath = join(rootDir, `libc-${arch.zigArch}-android.txt`)
  writeFileSync(libcFilePath, libcFileContent, { encoding: 'utf-8' })

  const env = {
    ...process.env,
    ANDROID_NDK_HOME: NDK_HOME,
    ANDROID_NDK_ROOT: NDK_HOME,
    XINCLI_ANDROID_LIB_PATH: sysrootLibApiSpecific,
    CC: join(ndkToolchainBin, `${arch.ndkTriple}${NDK_API_LEVEL}-clang`),
    CXX: join(ndkToolchainBin, `${arch.ndkTriple}${NDK_API_LEVEL}-clang++`),
    // CFLAGS: --sysroot + arch-specific -I for <asm/> headers that
    // <linux/types.h> includes. Without -I<sysroot>/usr/include/<triple>,
    // Zig's C import fails with 'asm/types.h' file not found.
    CFLAGS: `--sysroot=${sysroot} -I${sysrootIncludeArch}`,
    CXXFLAGS: `--sysroot=${sysroot} -I${sysrootIncludeArch}`,
    LDFLAGS: `--sysroot=${sysroot} -L${sysrootLibApiSpecific} -L${sysrootLibGeneric}`,
    LIBRARY_PATH: `${sysrootLibApiSpecific}:${sysrootLibGeneric}`,
  }

  // Pass the libc file via -Dtarget and --sysroot. The libc file is
  // passed via the ZIG_LIBC env var (Zig 0.15 reads this).
  const zigArgs = [
    "build",
    `-Dtarget=${zigTarget}`,
    `-Doptimize=ReleaseFast`,
    `--sysroot`,
    sysroot,
  ]
  // Set ZIG_LIBC to point at our generated libc file
  env.ZIG_LIBC = libcFilePath

  console.log(`  zig ${zigArgs.join(" ")}`)
  console.log(`  CC=${env.CC}`)
  console.log(`  sysroot=${sysroot}`)
  const result = spawnSync("zig", zigArgs, {
    cwd: join(rootDir, "src", "zig"),
    stdio: "inherit",
    env,
  })
  if (result.error || result.status !== 0) {
    console.error(`✗ Zig build ${zigTarget} failed`)
    process.exit(1)
  }
  console.log(`✓ Zig build ${zigTarget}`)

  // Locate the produced .so — Zig puts it under zig-out/lib/
  const srcSo = join(rootDir, "src", "zig", "zig-out", "lib", "libopentui.so")
  if (!existsSync(srcSo)) {
    console.error(`✗ libopentui.so not found at ${srcSo}`)
    console.error("  Check zig-out/ for the actual output location:")
    run("find", [join(rootDir, "src", "zig", "zig-out"), "-name", "libopentui.so"], rootDir, "search for .so")
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
