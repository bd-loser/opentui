import { readFileSync } from "node:fs"

export type LinuxLibc = "glibc" | "musl"

interface ProcessReport {
  header?: {
    glibcVersionRuntime?: string
    glibcVersionCompiler?: string
  }
  sharedObjects?: string[]
}

interface NativePackageOptions {
  platform?: string
  arch?: string
  linuxLibc?: LinuxLibc
}

type ProcessWithReport = typeof process & {
  report?: {
    getReport?: () => ProcessReport
  }
}

export function detectLinuxLibcFromReport(report: ProcessReport | undefined): LinuxLibc | null {
  if (report?.header?.glibcVersionRuntime || report?.header?.glibcVersionCompiler) {
    return "glibc"
  }

  if (report?.sharedObjects?.some(isMuslPath)) {
    return "musl"
  }

  return null
}

export function detectLinuxLibcFromMaps(maps: string): LinuxLibc | null {
  return maps.split("\n").some(isMuslPath) ? "musl" : null
}

export function detectLinuxLibc(): LinuxLibc {
  try {
    const report = (process as ProcessWithReport).report?.getReport?.()
    const reportLibc = detectLinuxLibcFromReport(report)
    if (reportLibc) return reportLibc
  } catch {
    // Fall back to /proc below.
  }

  try {
    const mapsLibc = detectLinuxLibcFromMaps(readFileSync("/proc/self/maps", "utf8"))
    if (mapsLibc) return mapsLibc
  } catch {
    // Default to the existing mainstream Linux package when libc cannot be detected.
  }

  return "glibc"
}

export function getNativePackageName(options: NativePackageOptions = {}): string {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const linuxLibc = platform === "linux" ? (options.linuxLibc ?? detectLinuxLibc()) : undefined

  return `@opentui/core-${platform}-${arch}${linuxLibc === "musl" ? "-musl" : ""}`
}

function isMuslPath(path: string): boolean {
  return path.includes("ld-musl") || path.includes("libc.musl")
}
