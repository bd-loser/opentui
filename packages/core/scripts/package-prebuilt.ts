// package-prebuilt.ts — Package a pre-built .so into npm packages.
//
// This runs in GitHub Actions AFTER you commit a .so built natively on
// Termux. It reads the .so from packages/core/prebuilt/<arch>/libopentui.so
// and produces the three npm package directories that ANDROIDTUI's
// resolveNativePackage() loads at runtime:
//
//   dist/@androidtui/core-android-arm64/libopentui.so
//   dist/@androidtui/core-android-arm/libopentui.so   (if present)
//   dist/@androidtui/core-android-x64/libopentui.so   (if present)
//
// No Zig, no NDK, no cross-compilation. Just packaging.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")

const PREBUILT_DIR = join(rootDir, "prebuilt")
const DIST_DIR = join(rootDir, "dist-prebuilt")

// Map prebuilt/ subdirectory names to npm package names and the CPU they
// were built for.
const ARCH_TO_PACKAGE: Record<string, { name: string; cpu: string }> = {
  "aarch64-android": { name: "@androidtui/core-android-arm64", cpu: "arm64" },
  "arm-android": { name: "@androidtui/core-android-arm", cpu: "arm" },
  "x86_64-android": { name: "@androidtui/core-android-x64", cpu: "x64" },
}

// npm and bun skip an optional dependency whose os/cpu don't match the
// host, which is how upstream keeps a macOS user from downloading eight
// platforms' worth of .so. We want the same, but "android" alone is not
// enough: Node on Termux reports process.platform === "android" while
// Bun reports "linux", so an android-only constraint would make
// `bun install` silently skip the very package it needs. Listing both
// covers either installer, at the cost of also installing on desktop
// linux-arm64 — where the resolver ignores it anyway.
const OS_LIST = ["android", "linux"]

function packageOne(archDir: string, packageName: string, cpu: string): void {
  const soPath = join(PREBUILT_DIR, archDir, "libopentui.so")
  if (!existsSync(soPath)) {
    console.log(`⊘ Skipping ${packageName} — no .so at ${soPath}`)
    return
  }

  const pkgDir = join(DIST_DIR, packageName)
  mkdirSync(pkgDir, { recursive: true })
  copyFileSync(soPath, join(pkgDir, "libopentui.so"))

  // Read version from core package.json so the prebuilt packages stay in sync
  const corePkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

  const pkgJson = {
    name: packageName,
    version: corePkg.version,
    description: `OpenTUI native core for Android ${archDir} (Termux). Built natively, packaged by ANDROIDTUI.`,
    repository: {
      type: "git",
      url: "git+https://github.com/bd-loser/opentui.git",
    },
    license: "MIT",
    type: "module",
    os: OS_LIST,
    cpu: [cpu],
    main: "index.js",
    module: "index.js",
    exports: {
      ".": {
        import: "./index.js",
        types: "./index.d.ts",
      },
    },
    files: ["libopentui.so", "index.js", "index.d.ts"],
  }

  // Create index.js that exports the .so path (not the .so itself).
  // Using `import ... with { type: "file" }` so `bun build --compile`
  // embeds libopentui.so into bunfs (with a hashed filename). Under
  // `bun run` this resolves to a real filesystem path; under a compiled
  // binary it resolves to `/$bunfs/root/libopentui-<hash>.so`, which
  // @androidtui/core's resolver extracts via Bun.file().
  //
  // The prior `new URL("./libopentui.so", import.meta.url)` pattern was
  // NOT picked up by Bun's asset scanner through a dynamic import
  // boundary, so the .so was never packed into bunfs and the compiled
  // binary failed at startup with:
  //   opentui: failed to extract native library from bunfs ... ENOENT
  const indexJsContent = `import libopentui from "./libopentui.so" with { type: "file" }

export default libopentui
`
  writeFileSync(join(pkgDir, "index.js"), indexJsContent)

  // Create index.d.ts
  writeFileSync(join(pkgDir, "index.d.ts"), "declare const path: string\nexport default path\n")

  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2))

  const sizeKb = Math.round(existsSync(soPath) ? require("fs").statSync(soPath).size / 1024 : 0)
  console.log(`✓ Packaged ${packageName} (${sizeKb} KB)`)
}

console.log("📦 Packaging prebuilt .so files...")
console.log(`   prebuilt dir: ${PREBUILT_DIR}`)

if (!existsSync(PREBUILT_DIR)) {
  console.error(`❌ No prebuilt/ directory found. Run build-native-termux.sh on a phone first.`)
  process.exit(1)
}

let packaged = 0
for (const [archDir, { name, cpu }] of Object.entries(ARCH_TO_PACKAGE)) {
  if (existsSync(join(PREBUILT_DIR, archDir, "libopentui.so"))) {
    packageOne(archDir, name, cpu)
    packaged++
  }
}

if (packaged === 0) {
  console.error(`❌ No .so files found in ${PREBUILT_DIR}.`)
  console.error(`   Expected one of: ${Object.keys(ARCH_TO_PACKAGE).join(", ")}`)
  console.error(`   Run build-native-termux.sh on a phone, then commit prebuilt/.`)
  process.exit(1)
}

console.log(`\n✅ Packaged ${packaged} variant(s) → ${DIST_DIR}`)
console.log("   Ready for npm publish.")
