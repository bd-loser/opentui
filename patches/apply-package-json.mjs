#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// XINCLI patch kit — package.json transform
//
// The four workspace package.json files need small, structural edits that
// are awkward to express as unified diffs: upstream reorders keys and
// bumps versions on every release, so a textual patch would conflict on
// almost every rebase. Applying the edits programmatically instead makes
// them version-agnostic.
//
// This does NOT rename anything. The tree keeps upstream's @opentui/*
// names so `workspace:*` linking works; scripts/xin-repackage.mjs does
// the rename in dist/ at publish time.
//
// Usage:
//   node patches/apply-package-json.mjs [--check]
//
//   --check   report what would change and exit non-zero if anything
//             would, without writing. Used by xin-regen.sh to detect
//             drift between the tree and what the kit produces.
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const checkOnly = process.argv.includes("--check")

/**
 * Each entry returns true when it changed something. Keep these edits
 * minimal and idempotent — they run again on every version bump.
 *
 * Deliberately NOT here: the @xincli/opentui-core-android-arm64 optional
 * dependency. It would name a version that does not exist on npm until
 * the release workflow publishes it, so carrying it in the tree only
 * risks `bun install` noise for no benefit — nothing in a source
 * checkout resolves through it (android-native.ts finds prebuilt/
 * first). scripts/xin-repackage.mjs injects it into dist/package.json at
 * publish time, which is the only place it matters.
 */
const TRANSFORMS = {
  core() {
    return false
  },

  react(pkg) {
    // Upstream marks react private; the fork publishes it.
    if (pkg.private === undefined) return false
    delete pkg.private
    return true
  },

  solid(pkg) {
    if (pkg.private === undefined) return false
    delete pkg.private
    return true
  },

  keymap() {
    // Not private upstream — nothing beyond the shared publish:xincli
    // script added below.
    return false
  },
}

let anyChanged = false

for (const [name, transform] of Object.entries(TRANSFORMS)) {
  const path = join(repoRoot, "packages", name, "package.json")
  const before = readFileSync(path, "utf8")
  const pkg = JSON.parse(before)

  let changed = transform(pkg)

  // A convenience alias so you can publish one package by hand from its
  // own directory: `bun run publish:xincli -- --publish`
  const publishCmd = `node ../../scripts/xin-repackage.mjs --package ${name}`
  if (pkg.scripts !== undefined && pkg.scripts["publish:xincli"] !== publishCmd) {
    pkg.scripts["publish:xincli"] = publishCmd
    changed = true
  }

  if (!changed) {
    console.log(`  packages/${name}/package.json  (already current)`)
    continue
  }

  anyChanged = true
  const after = `${JSON.stringify(pkg, null, 2)}\n`

  if (checkOnly) {
    console.log(`  packages/${name}/package.json  WOULD CHANGE`)
  } else {
    writeFileSync(path, after)
    console.log(`  packages/${name}/package.json  updated`)
  }
}

if (checkOnly && anyChanged) {
  console.error("\nThe tree does not match what the kit produces. Run without --check to fix.")
  process.exit(1)
}
