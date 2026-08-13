#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = join(resolve(process.env.ANDROIDTUI_WORK_ROOT ?? join(root, ".work")), "opentui")
const manifest = JSON.parse(readFileSync(join(root, "androidtui.json"), "utf8"))

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
]
for (const file of required) {
  if (!existsSync(join(sourceRoot, file))) throw new Error(`Generated source is missing ${file}`)
}

const changed = output("git", ["status", "--short"], sourceRoot)
if (!changed.includes("packages/core/src/node-asset-target.ts")) {
  throw new Error("Android native resolution patch was not applied")
}

for (const packageName of ["core", "react", "solid", "keymap", "qrcode", "three", "ssh"]) {
  const pkg = JSON.parse(readFileSync(join(sourceRoot, "packages", packageName, "package.json"), "utf8"))
  if (pkg.version !== manifest.upstream.tag.slice(1)) {
    throw new Error(`${packageName} version ${pkg.version} does not match ${manifest.upstream.tag}`)
  }
}

console.log(`Verified reproducible ANDROIDTUI source for ${manifest.upstream.tag} (${commit})`)
