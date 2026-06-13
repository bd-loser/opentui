import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "8.1.1"
const SHA256 = "b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3"
const URL = `https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz`
const BUILD_REVISION = "3"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cache = join(root, ".cache", "ffmpeg")
const archive = join(cache, "downloads", `ffmpeg-${VERSION}.tar.xz`)
const source = join(cache, "sources", `ffmpeg-${VERSION}`)

interface Target {
  name: string
  zig: string
  arch: "x86_64" | "aarch64"
  os: "darwin" | "linux" | "mingw32"
}

const targets: Target[] = [
  { name: "x86_64-linux", zig: "x86_64-linux-gnu.2.17", arch: "x86_64", os: "linux" },
  { name: "aarch64-linux", zig: "aarch64-linux-gnu.2.17", arch: "aarch64", os: "linux" },
  { name: "x86_64-linux-musl", zig: "x86_64-linux-musl", arch: "x86_64", os: "linux" },
  { name: "aarch64-linux-musl", zig: "aarch64-linux-musl", arch: "aarch64", os: "linux" },
  { name: "x86_64-macos", zig: "x86_64-macos", arch: "x86_64", os: "darwin" },
  { name: "aarch64-macos", zig: "aarch64-macos", arch: "aarch64", os: "darwin" },
  { name: "x86_64-windows", zig: "x86_64-windows-gnu", arch: "x86_64", os: "mingw32" },
  { name: "aarch64-windows", zig: "aarch64-windows-gnu", arch: "aarch64", os: "mingw32" },
]

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`)
  return result.stdout.trim()
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

async function prepareSource(): Promise<void> {
  mkdirSync(dirname(archive), { recursive: true })
  mkdirSync(dirname(source), { recursive: true })
  if (!existsSync(archive) || digest(archive) !== SHA256) {
    const response = await fetch(URL)
    if (!response.ok) throw new Error(`Failed to download FFmpeg: HTTP ${response.status}`)
    writeFileSync(archive, new Uint8Array(await response.arrayBuffer()))
  }
  if (digest(archive) !== SHA256) throw new Error("FFmpeg archive SHA-256 mismatch")
  if (!existsSync(source)) run("tar", ["-xf", archive, "-C", dirname(source)])
}

function hostTarget(): Target {
  const platform =
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : null
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null
  if (!platform || !arch) throw new Error(`Unsupported FFmpeg build host: ${process.platform}-${process.arch}`)
  const suffix = process.argv.includes("--test-host") && platform === "linux" ? "linux-musl" : platform
  const match = targets.find((target) => target.name === `${arch}-${suffix}`)
  if (!match) throw new Error(`Unsupported FFmpeg build host: ${process.platform}-${process.arch}`)
  return match
}

function buildTarget(target: Target): void {
  const prefix = join(cache, "prefix", target.name)
  const marker = join(prefix, ".opentui-build")
  if (
    existsSync(join(prefix, "lib", "libavcodec.a")) &&
    existsSync(marker) &&
    readFileSync(marker, "utf8") === BUILD_REVISION
  )
    return
  rmSync(prefix, { recursive: true, force: true })
  const build = join(cache, "build", target.name)
  const tools = join(cache, "toolchains", target.name)
  rmSync(build, { recursive: true, force: true })
  mkdirSync(build, { recursive: true })
  mkdirSync(tools, { recursive: true })

  const sdk = target.os === "darwin" ? run("xcrun", ["--sdk", "macosx", "--show-sdk-path"]) : ""
  const cc = join(tools, "cc")
  writeFileSync(
    cc,
    target.os === "darwin"
      ? `#!/bin/sh\nexec xcrun --sdk macosx clang -arch ${target.arch === "aarch64" ? "arm64" : "x86_64"} -isysroot "${sdk}" "$@"\n`
      : target.os === "mingw32"
        ? `#!/bin/bash\nargs=()\nfor arg in "$@"; do\n  if [[ "$arg" == "-Wl,--pic-executable,-e,mainCRTStartup" ]]; then arg="-Wl,-e,mainCRTStartup"; fi\n  args+=("$arg")\ndone\nexec zig cc -target ${target.zig} "\${args[@]}"\n`
        : `#!/bin/sh\nexec zig cc -target ${target.zig} "$@"\n`,
  )
  chmodSync(cc, 0o755)

  const configure = [
    `--prefix=${prefix}`,
    "--disable-everything",
    "--disable-autodetect",
    "--disable-programs",
    "--disable-doc",
    "--disable-debug",
    "--disable-network",
    "--disable-avdevice",
    "--disable-avfilter",
    "--disable-encoders",
    "--disable-muxers",
    "--disable-indevs",
    "--disable-outdevs",
    "--disable-hwaccels",
    "--disable-filters",
    "--disable-bzlib",
    "--disable-iconv",
    "--disable-lzma",
    "--disable-zlib",
    "--disable-gpl",
    "--disable-version3",
    "--disable-nonfree",
    "--enable-static",
    "--disable-shared",
    "--enable-small",
    "--enable-demuxer=mov",
    "--enable-decoder=h264,aac",
    "--enable-parser=h264,aac",
    "--enable-protocol=file",
    "--enable-swscale",
    "--enable-swresample",
    "--enable-cross-compile",
    `--cc=${cc}`,
    "--ar=zig ar",
    "--ranlib=zig ranlib",
    `--arch=${target.arch}`,
    `--target-os=${target.os}`,
    "--extra-cflags=-Os -ffunction-sections -fdata-sections -fvisibility=hidden",
    ...(target.arch === "x86_64" ? ["--disable-x86asm"] : []),
    ...(target.os === "mingw32" ? ["--disable-pic"] : ["--enable-pic"]),
    ...(target.os === "mingw32" ? ["--disable-pthreads", "--enable-w32threads"] : ["--enable-pthreads"]),
    ...(sdk ? [`--sysroot=${sdk}`] : []),
  ]
  run(join(source, "configure"), configure, build)
  if (target.os === "linux") {
    const configPath = join(build, "config.h")
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace("#define HAVE_SYSCTL 1", "#define HAVE_SYSCTL 0"),
    )
  }
  run("make", [`-j${Math.max(1, availableParallelism())}`], build)
  run("make", ["install"], build)
  writeFileSync(marker, BUILD_REVISION)
}

const requestedTarget = process.argv.find((argument) => argument.startsWith("--target="))?.slice("--target=".length)
const selectedTargets = process.argv.includes("--all")
  ? targets
  : requestedTarget
    ? [
        targets.find((target) => target.name === requestedTarget) ??
          (() => {
            throw new Error(`Unknown FFmpeg target: ${requestedTarget}`)
          })(),
      ]
    : [hostTarget()]
const targetIsBuilt = (target: Target): boolean => {
  const prefix = join(cache, "prefix", target.name)
  const marker = join(prefix, ".opentui-build")
  return (
    existsSync(join(prefix, "lib", "libavcodec.a")) &&
    existsSync(marker) &&
    readFileSync(marker, "utf8") === BUILD_REVISION
  )
}
if (!selectedTargets.every(targetIsBuilt)) await prepareSource()
for (const target of selectedTargets) buildTarget(target)
