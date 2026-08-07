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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
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
for (const field of ["dependencies", "peerDependencies", "devDependencies"]) {
  const deps = pkg[field]
  if (deps === undefined) continue
  for (const [name, range] of Object.entries(deps)) {
    const renamed = RENAMES[name]
    if (renamed === undefined) continue
    deps[name] = `npm:${renamed}@${version}`
    console.log(`  ${field}: ${name} -> ${deps[name]} (was ${range})`)
  }
}

// core carries the native library as optional deps: upstream's own
// per-platform packages plus our Android one, all pinned to this version.
if (pkgKey === "core") {
  const opts = pkg.optionalDependencies ?? {}
  for (const name of Object.keys(opts)) {
    if (name.startsWith("@opentui/core-")) opts[name] = version
  }
  opts[`${SCOPE}/opentui-core-android-arm64`] = version
  pkg.optionalDependencies = opts
  console.log(`  optionalDependencies: ${Object.keys(opts).join(", ")}`)
}

writeFileSync(distPkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`  [OK] ${pkg.name}@${pkg.version}`)

// ── 3. Node ESM fixup (react only) ─────────────────────────────────────

// Bun resolves bare subpath imports like "react-reconciler/constants"
// without an extension; Node ESM does not. Add the .js so the published
// package works under plain Node.
if (pkgKey === "react") {
  console.log(`\n=== Step 3: Node ESM subpath fixup ===`)
  let patched = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith(".js")) {
        const before = readFileSync(full, "utf8")
        const after = before.replace(/from "(react-reconciler)\/([A-Za-z0-9_/-]+)"/g, 'from "$1/$2.js"')
        if (after !== before) {
          writeFileSync(full, after)
          patched += 1
        }
      }
    }
  }
  walk(distDir)
  console.log(`  [OK] patched ${patched} file(s)`)
}

// ── 4. pack ────────────────────────────────────────────────────────────

console.log(`\n=== Step 4: npm pack ===`)
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
