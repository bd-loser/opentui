#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(resolve(process.env.ANDROIDTUI_WORK_ROOT ?? join(root, ".work")), "opentui")
const manifest = JSON.parse(readFileSync(join(root, "androidtui.json"), "utf8"))

if (!/^\d+\.\d+\.\d+(?:-(?:android|future)\.\d+)?$/.test(manifest.releaseVersion)) {
  throw new Error(`Invalid Android release version: ${manifest.releaseVersion}`)
}
const releaseBase = manifest.releaseVersion.split("-")[0]
const upstreamBase = manifest.upstream.tag.slice(1)

// Compare numerically. String comparison gets 0.5.10 vs 0.5.9 backwards.
function compareVersions(a, b) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return 0
}
const versionOrder = compareVersions(releaseBase, upstreamBase)

if (manifest.releaseVersion.includes("-future.") && versionOrder >= 0) {
  throw new Error(`Future preview ${manifest.releaseVersion} must precede upstream ${manifest.upstream.tag}`)
}
if (!manifest.releaseVersion.includes("-future.") && versionOrder > 0) {
  throw new Error(`${manifest.releaseVersion} is ahead of upstream ${manifest.upstream.tag}`)
}
// A stable releaseVersion below upstream is a deliberate test publish: it
// burns an unused npm version to exercise the pipeline on newer upstream
// code without consuming the number that upstream release will claim.
if (!manifest.releaseVersion.includes("-future.") && versionOrder < 0) {
  console.warn(
    `Note: publishing upstream ${manifest.upstream.tag} as ${manifest.releaseVersion} ` +
      `(behind upstream). Intended for test releases.`,
  )
}

if (!existsSync(join(sourceRoot, ".git"))) {
  console.error("Generated source is missing. Run: npm run prepare:upstream")
  process.exit(1)
}

function output(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr ?? "")
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

const commit = output("git", ["rev-parse", "HEAD"], sourceRoot)
if (commit !== manifest.upstream.commit) throw new Error(`Expected ${manifest.upstream.commit}, got ${commit}`)

const required = [
  "packages/core/src/platform/android-native.ts",
  "packages/core/src/platform/bunfs-extract.ts",
  "packages/core/scripts/build-native-termux.sh",
  "packages/core/scripts/package-prebuilt.ts",
  "scripts/androidtui-repackage.mjs",
  // Upstream 0.5.6 split the Zig sources into their own workspace package and
  // vendored the Zig dependencies in-repo. Both are load-bearing for the
  // Termux build, so a future upstream move should fail here, not mid-build.
  "packages/native/build.zig",
  "packages/native/scripts/prepare-zig-deps.sh",
  "packages/native/src/vendor/zig-deps.tar.gz",
  "packages/native/src/android-translate-compat/sys/time.h",
]
for (const file of required) {
  if (!existsSync(join(sourceRoot, file))) throw new Error(`Generated source is missing ${file}`)
}

const changed = output("git", ["status", "--short"], sourceRoot)
if (!changed.includes("packages/core/src/node-asset-target.ts")) {
  throw new Error("Android native resolution patch was not applied")
}
if (!changed.includes("packages/native/build.zig")) {
  throw new Error("Android Zig build patch was not applied")
}

for (const packageName of ["core", "react", "solid", "keymap", "qrcode", "three", "ssh"]) {
  const pkg = JSON.parse(readFileSync(join(sourceRoot, "packages", packageName, "package.json"), "utf8"))
  if (pkg.version !== manifest.upstream.tag.slice(1)) {
    throw new Error(`${packageName} version ${pkg.version} does not match ${manifest.upstream.tag}`)
  }
}

console.log(
  `Verified reproducible ANDROIDTUI ${manifest.releaseVersion} source from upstream ${manifest.upstream.tag} (${commit})`,
)
