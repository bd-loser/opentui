// package-prebuilt.ts — Package a pre-built .so into npm packages.
//
// This runs in GitHub Actions AFTER you commit a .so built natively on
// Termux. It reads the .so from packages/core/prebuilt/<arch>/libopentui.so
// and produces the three npm package directories that XINCLI's
// resolveNativePackage() loads at runtime:
//
//   dist/@xincli/opentui-core-android-arm64/libopentui.so
//   dist/@xincli/opentui-core-android-arm/libopentui.so   (if present)
//   dist/@xincli/opentui-core-android-x64/libopentui.so   (if present)
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

// Map prebuilt/ subdirectory names to npm package names.
const ARCH_TO_PACKAGE: Record<string, string> = {
  "aarch64-android": "@xincli/opentui-core-android-arm64",
  "arm-android": "@xincli/opentui-core-android-arm",
  "x86_64-android": "@xincli/opentui-core-android-x64",
}

function packageOne(archDir: string, packageName: string): void {
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
    description: `OpenTUI native core for Android ${archDir} (Termux). Built natively, packaged by XINCLI.`,
    repository: {
      type: "git",
      url: "git+https://github.com/bd-loser/opentui.git",
    },
    license: "MIT",
    type: "module",
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
  // @xincli/opentui-core's resolver extracts via Bun.file().
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
for (const [archDir, packageName] of Object.entries(ARCH_TO_PACKAGE)) {
  if (existsSync(join(PREBUILT_DIR, archDir, "libopentui.so"))) {
    packageOne(archDir, packageName)
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
