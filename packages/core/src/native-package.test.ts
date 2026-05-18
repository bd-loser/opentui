import { describe, expect, test } from "bun:test"

import { detectLinuxLibcFromMaps, detectLinuxLibcFromReport, getNativePackageName } from "./native-package.js"

describe("native package resolution", () => {
  test("keeps existing package names for non-Linux targets", () => {
    expect(getNativePackageName({ platform: "darwin", arch: "arm64" })).toBe("@opentui/core-darwin-arm64")
    expect(getNativePackageName({ platform: "win32", arch: "x64" })).toBe("@opentui/core-win32-x64")
  })

  test("keeps existing Linux package names for glibc", () => {
    expect(getNativePackageName({ platform: "linux", arch: "x64", linuxLibc: "glibc" })).toBe("@opentui/core-linux-x64")
    expect(getNativePackageName({ platform: "linux", arch: "arm64", linuxLibc: "glibc" })).toBe(
      "@opentui/core-linux-arm64",
    )
  })

  test("adds musl suffix for Linux musl", () => {
    expect(getNativePackageName({ platform: "linux", arch: "x64", linuxLibc: "musl" })).toBe(
      "@opentui/core-linux-x64-musl",
    )
    expect(getNativePackageName({ platform: "linux", arch: "arm64", linuxLibc: "musl" })).toBe(
      "@opentui/core-linux-arm64-musl",
    )
  })

  test("detects glibc from process report", () => {
    expect(detectLinuxLibcFromReport({ header: { glibcVersionRuntime: "2.39" } })).toBe("glibc")
    expect(detectLinuxLibcFromReport({ header: { glibcVersionCompiler: "2.17" } })).toBe("glibc")
  })

  test("detects musl from process report and proc maps", () => {
    expect(detectLinuxLibcFromReport({ sharedObjects: ["/lib/ld-musl-x86_64.so.1"] })).toBe("musl")
    expect(detectLinuxLibcFromMaps("7f000000-7f100000 r-xp 00000000 00:00 0 /lib/ld-musl-x86_64.so.1")).toBe("musl")
  })
})
