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
//   --npm-tag <tag>                       dist-tag to publish under (default: latest)
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

// The fork tracks upstream releases exactly, but sometimes needs to ship a
// fix to its own packaging between two upstream tags. That is expressed as a
// prerelease suffix on the upstream base: 0.5.1 -> 0.5.1-bun.
//
// Anything published under @xincli uses the full fork version. Anything still
// resolved from upstream — the non-Android core-<platform> binaries — must use
// the base, because upstream publishes 0.5.1 and never 0.5.1-bun.
const upstreamVersion = version.replace(/-.*$/, "")

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
// The Android one is published by this fork, as
// @xincli/opentui-core-android-arm64 — upstream has no such package. It
// is declared as an ALIAS under upstream's own name:
//
//   "@opentui/core-android-arm64":
//       "npm:@xincli/opentui-core-android-arm64@<version>"
//
// which is the same shape step 2 gives every cross-package edge, and for
// the same reason: `npm:` materialises node_modules/@opentui/core-android-arm64,
// so the string LITERAL in src/platform/android-native.ts resolves, and
// build.ts already derives that exact name for the android variant.
//
// Renaming the KEY to @xincli instead — which this script used to do —
// resolves equally well, but permanently welds the native package to the
// registry. npm indexes dependents by dependency key, so a literal
// @xincli key makes @xincli/opentui-core-android-arm64 a package with
// dependents, and npm then refuses to unpublish ANY version of it:
//
//   405 Method Not Allowed - You can no longer unpublish this package.
//   Failed criteria: has dependent packages in the registry
//
// Four broken 0.5.x builds got stuck on the registry that way, with no
// route to remove them while any published core held the literal key.
// Under the alias the key is @opentui/core-android-arm64, so the fork's
// own package stays unpublishable-free and a bad build can be withdrawn.
if (pkgKey === "core") {
  const opts = {}
  for (const [name, range] of Object.entries(pkg.optionalDependencies ?? {})) {
    if (name.startsWith("@opentui/core-android")) {
      const target = name.replace("@opentui/core-", `${SCOPE}/opentui-core-`)
      opts[name] = `npm:${target}@${version}`
      console.log(`  optionalDependencies: ${name} -> ${opts[name]} (was ${range})`)
    } else if (name.startsWith(`${SCOPE}/opentui-core-android`)) {
      // A leftover literal @xincli key from an older working tree. Drop
      // it: build.ts always emits the @opentui/core-android-arm64 key
      // above, the alias there already points at this same package, and
      // keeping both would publish the literal key that blocks unpublish.
      console.log(`  optionalDependencies: dropped literal ${name} (aliased above)`)
    } else {
      opts[name] = name.startsWith("@opentui/core-") ? upstreamVersion : range
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
// @xincli/opentui-core the SELF-import does not, and the failure is
// invisible under Node (the paths are lazy) but immediate under Bun:
//
//   Cannot find module '@opentui/core/parser.worker'
//
// A dependency alias papers over this whenever a binding is installed,
// because `npm:` materialises node_modules/@opentui/core — but
// `npm install @xincli/opentui-core` on its own has no such luck.
// Rewrite the self-references so the packages stand alone.
//
// The negative lookahead matters: @opentui/core-linux-x64 and friends are
// upstream's real prebuilt binaries, still resolved from upstream, and
// must NOT be renamed.
console.log(`\n=== Step 3: rewrite self-referencing import specifiers ===`)

// Only SELF-references get rewritten. A cross-package edge (solid or keymap
// importing core) must keep the upstream specifier, because step 2 declares
// that edge as an alias whose *key* is the upstream name:
//
//   "@opentui/core": "npm:@xincli/opentui-core@<version>"
//
// which installs to node_modules/@opentui/core. Rewriting the specifier to
// @xincli/opentui-core points it at a directory the alias never creates:
//
//   Cannot find module '@xincli/opentui-core' from '.../@opentui/solid/index.bun.js'
//
// Keeping the alias also keeps core a single instance. Declaring the edge
// under its real name instead would resolve, but a consumer that aliases
// @opentui/core for its own source (as opencode does) would then get two
// copies of core — two module instances, two dlopens of the same .so.
//
// And only strings in an actual import position get rewritten. Matching
// every quoted "@opentui/solid" also hit this, in scripts/solid-transform.js:
//
//   moduleName: options.moduleName ?? "@opentui/solid"
//
// which is not a specifier this package resolves — it is the name the Solid
// JSX transform *writes into the consumer's* compiled output. The consumer
// resolves it, and the consumer has node_modules/@opentui/solid from the
// alias, so renaming it broke every build that uses the plugin:
//
//   error: Could not resolve: "@xincli/opentui-solid"
//     at packages/tui/src/context/helper.tsx:1:54
//
// Same invariant as above, one level out: anything a CONSUMER resolves stays
// upstream-named. Only what this package resolves for itself gets renamed.
const SELF_NAME = `@opentui/${pkgKey}`
const SELF_RENAMED = RENAMES[SELF_NAME]

// from "x" / import "x" / import("x") / require("x"), including the
// no-whitespace forms bundlers emit (`import{a}from"x"`).
const SPECIFIER_RE = /\b(from|import|require)(\s*\(\s*|\s*)(["'])(@opentui\/[^"'/]+)((?:\/[^"']*)?)\3/g

// One more exception, same shape as moduleName: an import statement that
// lives INSIDE a template literal is code this package generates for a
// consumer, not code it runs. lib/tree-sitter/assets/update.ts emits a
// parser-assets file into the user's project containing
//
//   `import { resolveBundledFilePath } from "@opentui/core"`
//
// which the USER's tree then has to resolve. Backtick parity is a cheap
// test for that: a real import is never inside a template literal, and
// when the count is thrown off the failure mode is a skipped rename —
// which still resolves under an alias, the way opencode consumes this.
const insideTemplateLiteral = (src, offset) => {
  let ticks = 0
  for (let i = 0; i < offset; i++) {
    if (src[i] === "`" && src[i - 1] !== "\\") ticks++
  }
  return ticks % 2 === 1
}

const rewriteSpecifiers = (src) =>
  src.replace(SPECIFIER_RE, (match, kw, gap, quote, name, subpath, offset) => {
    // A non-self @opentui/* name — a cross-package edge, or one of
    // upstream's @opentui/core-<platform> binaries — is left alone.
    if (name !== SELF_NAME) return match
    if (insideTemplateLiteral(src, offset)) return match
    return `${kw}${gap}${quote}${SELF_RENAMED}${subpath}${quote}`
  })

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
    let after = rewriteSpecifiers(before)

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

// npm refuses to publish a prerelease version without an explicit --tag:
//
//   npm error You must specify a tag using --tag when publishing a prerelease version.
//
// The fork uses a prerelease suffix for packaging fixes between upstream
// tags (0.5.1 -> 0.5.1-bun), so this is the normal path, not an edge case.
// "latest" is correct: a suffixed release exists because the unsuffixed one
// is broken, so a bare `npm install` should land on the fixed build. Pass
// --npm-tag to park a release somewhere else instead.
const npmTag = flag("npm-tag") ?? "latest"
run("npm", ["publish", tgz, "--access", "public", "--tag", npmTag])

console.log(`\n${"=".repeat(58)}`)
console.log(`SUCCESS: ${publishedName}@${version} published`)
console.log("=".repeat(58))
console.log(`\n  npm install ${publishedName}@${version} --legacy-peer-deps`)
