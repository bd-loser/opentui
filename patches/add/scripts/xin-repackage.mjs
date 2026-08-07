#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// XINCLI OpenTUI fork — unified repackager
//
// Builds one of the four JS packages, rewrites its dist/package.json to
// the @xincli identity, packs it, and optionally publishes it.
//
// The working tree keeps upstream's @opentui/* names so that
// `workspace:*` linking and `bun install` behave exactly as upstream
// intends, and so the diff against an upstream tag stays small. The
// rename happens here, in dist/, at publish time only.
//
// Usage:
//   node scripts/xin-repackage.mjs --package core   --version 0.5.0
//   node scripts/xin-repackage.mjs --package solid  --version 0.5.0 --publish
//
// Flags:
//   --package <core|react|solid|keymap>   required
//   --version <semver>                    required
//   --publish                             npm publish (default: dry run)
//   --skip-build                          reuse an existing dist/
//
// This replaces four near-identical copies of the same logic that used
// to live in packages/{solid,keymap}/scripts/publish-xincli.ts and
// inline in .github/workflows/publish-js-library.yml.
// ═══════════════════════════════════════════════════════════════════════

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const REPO_URL = "git+https://github.com/bd-loser/opentui.git"
const SCOPE = "@xincli"

/** Upstream package name -> the @xincli name it is published under. */
const RENAMES = {
  "@opentui/core": `${SCOPE}/opentui-core`,
  "@opentui/react": `${SCOPE}/opentui-react`,
  "@opentui/solid": `${SCOPE}/opentui-solid`,
  "@opentui/keymap": `${SCOPE}/opentui-keymap`,
}

const PACKAGES = {
  core: {
    dir: "packages/core",
    build: ["bun", "scripts/build.ts", "--lib"],
    description: "XINCLI fork of OpenTUI core — with Android/Termux support via @xincli/opentui-core-android-*",
  },
  react: {
    dir: "packages/react",
    build: ["bun", "scripts/build.ts"],
    description: "XINCLI fork of OpenTUI React binding — for use with @xincli/opentui-core",
  },
  solid: {
    dir: "packages/solid",
    build: ["bun", "scripts/build.ts"],
    description: "XINCLI fork of OpenTUI SolidJS binding — for use with @xincli/opentui-core",
  },
  keymap: {
    dir: "packages/keymap",
    build: ["bun", "scripts/build.ts"],
    description: "XINCLI fork of OpenTUI keymap — for use with @xincli/opentui-core",
  },
}

// ── args ───────────────────────────────────────────────────────────────

function flag(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const pkgKey = flag("package")
const shouldPublish = process.argv.includes("--publish")
const skipBuild = process.argv.includes("--skip-build")

if (pkgKey === undefined || PACKAGES[pkgKey] === undefined) {
  console.error(`--package must be one of: ${Object.keys(PACKAGES).join(", ")}`)
  process.exit(2)
}

const spec = PACKAGES[pkgKey]
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkgRoot = join(repoRoot, spec.dir)
const distDir = join(pkgRoot, "dist")
const artifactsDir = join(repoRoot, "artifacts")
const publishedName = RENAMES[`@opentui/${pkgKey}`]

// The fork tracks upstream versions exactly, so the package's own version
// is the release version unless a --version override says otherwise.
const version = flag("version") ?? JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version

if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`--version must be a semver string, got: ${String(version)}`)
  process.exit(2)
}

console.log("=".repeat(58))
console.log(`Repackaging ${publishedName}@${version}`)
console.log("=".repeat(58))
console.log(`  source dir: ${spec.dir}`)
console.log(`  publish:    ${shouldPublish}`)
console.log("=".repeat(58))

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts })
  if (r.error || r.status !== 0) {
    console.error(`FAIL: ${cmd} ${args.join(" ")}`)
    process.exit(1)
  }
  return r
}

// ── 1. build ───────────────────────────────────────────────────────────

if (skipBuild) {
  console.log("\n=== Step 1: build (skipped) ===")
} else {
  console.log(`\n=== Step 1: build @opentui/${pkgKey} ===`)
  run(spec.build[0], spec.build.slice(1), { cwd: pkgRoot })
}

const distPkgPath = join(distDir, "package.json")
if (!existsSync(distPkgPath)) {
  console.error(`FAIL: ${distPkgPath} not found — did the build run?`)
  process.exit(1)
}

// ── 2. rewrite identity + dependency aliases ───────────────────────────

console.log(`\n=== Step 2: rewrite dist/package.json ===`)
const pkg = JSON.parse(readFileSync(distPkgPath, "utf8"))

pkg.name = publishedName
pkg.version = version
pkg.description = spec.description
pkg.repository = { type: "git", url: REPO_URL, directory: spec.dir }
delete pkg.private

// Point every intra-fork @opentui/* edge at its @xincli counterpart, so a
// consumer never pulls upstream @opentui/core — which throws
// "opentui is not supported" on Termux.
for (const field of ["dependencies", "peerDependencies"]) {
  const deps = pkg[field]
  if (deps === undefined) continue
  for (const [name, range] of Object.entries(deps)) {
    const renamed = RENAMES[name]
    if (renamed === undefined) continue
    deps[name] = `npm:${renamed}@${version}`
    console.log(`  ${field}: ${name} -> ${deps[name]} (was ${range})`)
  }
}

// devDependencies are never installed by consumers, and the workspace
// entries here would otherwise be published as literal "workspace:*",
// which is not a valid npm range. Upstream drops them from its published
// packages; do the same rather than inventing versions for them.
if (pkg.devDependencies !== undefined) {
  for (const name of Object.keys(pkg.devDependencies)) {
    if (RENAMES[name] === undefined && !name.startsWith("@opentui/")) continue
    delete pkg.devDependencies[name]
    console.log(`  devDependencies: dropped ${name}`)
  }
}

// core carries the native library as optional deps, one per platform,
// all pinned to this version.
//
// The non-Android ones stay pointed at upstream's published binaries —
// they are the same artifacts this fork would produce, so there is no
// reason to republish them under @xincli.
//
// The Android ones must be renamed. scripts/build.ts adds an
// { platform: "android" } variant, so the generated dist/package.json
// names it @opentui/core-android-arm64 by convention — but upstream
// never publishes that, and we publish @xincli/opentui-core-android-*.
// Left unrenamed it is a permanent 404 in every consumer's install log.
if (pkgKey === "core") {
  const opts = {}
  for (const [name, range] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (name.startsWith("@opentui/core-android")) {
      const renamed = name.replace("@opentui/core-", `${SCOPE}/opentui-core-`)
      opts[renamed] = version
      console.log(`  optionalDependencies: ${name} -> ${renamed}@${version} (was ${range})`)
    } else {
      opts[name] = name.startsWith("@opentui/core-") ? version : range
    }
  }
  pkg.optionalDependencies = opts
  console.log(`  optionalDependencies: ${Object.keys(opts).length} platform(s)`)
}

writeFileSync(distPkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`  [OK] ${pkg.name}@${pkg.version}`)

// ── 3. rewrite intra-fork import specifiers in the built JS ────────────

// The compiled output imports sibling packages — and itself — by upstream
// name: `import("@opentui/core/parser.worker")`, `from "@opentui/core"`.
// A package may import itself by name, so this works upstream. Renamed to
// @xincli/opentui-core it does not, and the failure is invisible under
// Node (the paths are lazy) but immediate under Bun:
//
//   Cannot find module '@opentui/core/parser.worker'
//
// The dependency aliases below happen to paper over this whenever a
// binding is installed, because `npm:` materialises node_modules/@opentui/core
// — but `npm install @xincli/opentui-core` on its own has no such luck.
// Rewrite the specifiers so the packages stand alone.
//
// The negative lookahead matters: @opentui/core-linux-x64 and friends are
// upstream's real prebuilt binaries, still resolved from upstream, and
// must NOT be renamed.
console.log(`\n=== Step 3: rewrite intra-fork import specifiers ===`)

const SPECIFIER_RULES = Object.entries(RENAMES).map(([from, to]) => ({
  // "@opentui/core" or "@opentui/core/sub", never "@opentui/core-linux-x64"
  re: new RegExp(`(["'])${from.replace("/", "\\/")}(?=\\1|/)`, "g"),
  to: `$1${to}`,
  from,
}))

let rewritten = 0
const rewriteTree = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      rewriteTree(full)
      continue
    }
    if (!/\.(js|mjs|cjs)$/.test(entry)) continue

    const before = readFileSync(full, "utf8")
    let after = before
    for (const rule of SPECIFIER_RULES) after = after.replace(rule.re, rule.to)

    // Bun resolves bare subpath imports like "react-reconciler/constants"
    // without an extension; Node ESM does not.
    if (pkgKey === "react") {
      after = after.replace(/from "(react-reconciler)\/([A-Za-z0-9_/-]+)"/g, 'from "$1/$2.js"')
    }

    if (after !== before) {
      writeFileSync(full, after)
      rewritten += 1
    }
  }
}
rewriteTree(distDir)
console.log(`  [OK] rewrote ${rewritten} file(s)`)

// ── 4. pack ────────────────────────────────────────────────────────────

console.log(`\n=== Step 4: npm pack ===`)
mkdirSync(artifactsDir, { recursive: true })
run("npm", ["pack", distDir, "--pack-destination", artifactsDir])

const tgz = join(artifactsDir, `xincli-opentui-${pkgKey}-${version}.tgz`)
if (!existsSync(tgz)) {
  console.error(`FAIL: expected tarball not found at ${tgz}`)
  process.exit(1)
}
console.log(`  [OK] ${tgz}`)

// ── 5. publish ─────────────────────────────────────────────────────────

if (!shouldPublish) {
  console.log(`\n${"=".repeat(58)}`)
  console.log("Dry run complete — pass --publish to push to npm.")
  console.log("=".repeat(58))
  process.exit(0)
}

console.log(`\n=== Step 5: npm publish ===`)
run("npm", ["publish", tgz, "--access", "public"])

console.log(`\n${"=".repeat(58)}`)
console.log(`SUCCESS: ${publishedName}@${version} published`)
console.log("=".repeat(58))
console.log(`\n  npm install ${publishedName}@${version} --legacy-peer-deps`)
