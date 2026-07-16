// publish-xincli.ts — Publish @xincli/opentui-solid
//
// This script builds the solid package (same as `bun scripts/build.ts`),
// then repackages the dist/ output as @xincli/opentui-solid with the
// @opentui/core dependency aliased to npm:@xincli/opentui-core.
//
// This eliminates the need for consumers to use `overrides` in their
// package.json — @xincli/opentui-solid directly depends on
// @xincli/opentui-core, so there's no upstream @opentui/core@0.4.3
// that would crash on Termux with "opentui is not supported".
//
// Usage:
//   bun scripts/publish-xincli.ts              # build + verify, no publish
//   bun scripts/publish-xincli.ts --publish    # build + verify + npm publish
//
// Prerequisites:
//   - NPM_AUTH_TOKEN env var set (or ~/.npmrc configured for @xincli scope)
//   - @xincli/opentui-core@<version> already published to npm

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

interface PackageJson {
  name: string
  version: string
  description?: string
  repository?: { type: string; url: string; directory?: string }
  license?: string
  type?: string
  main?: string
  module?: string
  types?: string
  exports?: Record<string, any>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  files?: string[]
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")

const SHOULD_PUBLISH = process.argv.includes("--publish")

// Read the source package.json
const sourcePkg: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))
const VERSION = sourcePkg.version

console.log("==========================================")
console.log(`Publishing @xincli/opentui-solid@${VERSION}`)
console.log("==========================================")
console.log(`  source version: ${VERSION}`)
console.log(`  publish:        ${SHOULD_PUBLISH}`)
console.log("==========================================")

// --- Step 1: Build the package (produces dist/) ----------------------------
console.log("\n=== Step 1: Build @opentui/solid ===")
const buildResult: SpawnSyncReturns<Buffer> = spawnSync("bun", ["scripts/build.ts"], {
  cwd: rootDir,
  stdio: "inherit",
})
if (buildResult.error || buildResult.status !== 0) {
  console.error("FAIL: build.ts failed")
  process.exit(1)
}
console.log("  [OK] build succeeded")

// --- Step 2: Verify dist/ exists -------------------------------------------
const distDir = join(rootDir, "dist")
if (!existsSync(distDir)) {
  console.error(`FAIL: dist/ not found at ${distDir}`)
  process.exit(1)
}
const distPkgPath = join(distDir, "package.json")
if (!existsSync(distPkgPath)) {
  console.error(`FAIL: dist/package.json not found`)
  process.exit(1)
}
console.log("  [OK] dist/package.json exists")

// --- Step 3: Repackage as @xincli/opentui-solid ----------------------------
console.log("\n=== Step 2: Repackage as @xincli/opentui-solid ===")

const distPkg: PackageJson = JSON.parse(readFileSync(distPkgPath, "utf8"))

// Rewrite the package identity
distPkg.name = "@xincli/opentui-solid"
distPkg.version = VERSION
distPkg.description = "XINCLI fork of OpenTUI SolidJS binding — for use with @xincli/opentui-core"
distPkg.repository = {
  type: "git",
  url: "git+https://github.com/bd-loser/opentui.git",
  directory: "packages/solid",
}

// Alias @opentui/core → npm:@xincli/opentui-core in dependencies
// This is the KEY change: when a consumer installs @xincli/opentui-solid,
// npm/bun fetches @xincli/opentui-core (which has Android support) instead
// of upstream @opentui/core (which crashes on Termux).
if (distPkg.dependencies && distPkg.dependencies["@opentui/core"]) {
  distPkg.dependencies["@opentui/core"] = `npm:@xincli/opentui-core@${VERSION}`
}
if (distPkg.peerDependencies && distPkg.peerDependencies["@opentui/core"]) {
  distPkg.peerDependencies["@opentui/core"] = `npm:@xincli/opentui-core@${VERSION}`
}

// Also alias @opentui/keymap if present
if (distPkg.dependencies && distPkg.dependencies["@opentui/keymap"]) {
  distPkg.dependencies["@opentui/keymap"] = `npm:@xincli/opentui-keymap@${VERSION}`
}
if (distPkg.peerDependencies && distPkg.peerDependencies["@opentui/keymap"]) {
  distPkg.peerDependencies["@opentui/keymap"] = `npm:@xincli/opentui-keymap@${VERSION}`
}

writeFileSync(distPkgPath, JSON.stringify(distPkg, null, 2) + "\n")
console.log(`  [OK] repackaged as ${distPkg.name}@${distPkg.version}`)
console.log(`       dependencies: ${JSON.stringify(distPkg.dependencies, null, 2)}`)

// --- Step 4: Pack into a .tgz for verification -----------------------------
console.log("\n=== Step 3: Pack (npm pack) ===")
const artifactsDir = join(rootDir, "..", "..", "artifacts")
mkdirSync(artifactsDir, { recursive: true })

const packResult: SpawnSyncReturns<Buffer> = spawnSync(
  "npm",
  ["pack", distDir, "--pack-destination", artifactsDir],
  { stdio: "inherit" },
)
if (packResult.error || packResult.status !== 0) {
  console.error("FAIL: npm pack failed")
  process.exit(1)
}
console.log("  [OK] packed")

// --- Step 5: Publish (if --publish) ----------------------------------------
if (!SHOULD_PUBLISH) {
  console.log("\n==========================================")
  console.log("Dry run complete (no --publish flag)")
  console.log("==========================================")
  console.log(`\nTo publish:`)
  console.log(`  bun scripts/publish-xincli.ts --publish`)
  console.log(`\nArtifact:`)
  console.log(`  ${artifactsDir}/xincli-opentui-solid-${VERSION}.tgz`)
  process.exit(0)
}

console.log("\n=== Step 4: Publish to npm ===")

// Check npm auth
const whoami: SpawnSyncReturns<Buffer> = spawnSync("npm", ["whoami"], { stdio: "pipe" })
if (whoami.status !== 0) {
  console.error("FAIL: npm not authenticated. Run `npm login` or set NPM_AUTH_TOKEN")
  process.exit(1)
}
console.log(`  [OK] npm authenticated as: ${whoami.stdout.toString().trim()}`)

const tgzPath = join(artifactsDir, `xincli-opentui-solid-${VERSION}.tgz`)
const publishResult: SpawnSyncReturns<Buffer> = spawnSync(
  "npm",
  ["publish", tgzPath, "--access", "public"],
  { stdio: "inherit" },
)
if (publishResult.error || publishResult.status !== 0) {
  console.error(`FAIL: npm publish failed for @xincli/opentui-solid@${VERSION}`)
  process.exit(1)
}

console.log(`\n==========================================`)
console.log(`SUCCESS: @xincli/opentui-solid@${VERSION} published!`)
console.log(`==========================================`)
console.log(`\nInstall with:`)
console.log(`  npm install @xincli/opentui-solid@${VERSION} --legacy-peer-deps`)
