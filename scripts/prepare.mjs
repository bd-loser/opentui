#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workRoot = resolve(process.env.ANDROIDTUI_WORK_ROOT ?? join(root, ".work"))
const sourceRoot = join(workRoot, "opentui")
const manifest = JSON.parse(readFileSync(join(root, "androidtui.json"), "utf8"))

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" })
  if (result.error || result.status !== 0) process.exit(result.status ?? 1)
}

if (process.argv.includes("--clean")) {
  rmSync(workRoot, { recursive: true, force: true })
  console.log(`Removed ${workRoot}`)
  process.exit(0)
}

rmSync(sourceRoot, { recursive: true, force: true })
mkdirSync(sourceRoot, { recursive: true })

run("git", ["init", "--quiet"], sourceRoot)
run("git", ["remote", "add", "origin", manifest.upstream.repository], sourceRoot)
run("git", ["fetch", "--depth=1", "origin", `refs/tags/${manifest.upstream.tag}`], sourceRoot)
run("git", ["checkout", "--detach", "FETCH_HEAD"], sourceRoot)

const actualCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).stdout.trim()
if (actualCommit !== manifest.upstream.commit) {
  throw new Error(`Upstream commit mismatch: expected ${manifest.upstream.commit}, got ${actualCommit}`)
}

const series = readFileSync(join(root, "patches", "series"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)

for (const patch of series) {
  const patchPath = join(root, "patches", patch)
  if (!existsSync(patchPath)) throw new Error(`Missing patch: ${patch}`)
  run("git", ["apply", "--check", patchPath], sourceRoot)
  run("git", ["apply", patchPath], sourceRoot)
}

cpSync(join(root, "overlay"), sourceRoot, { recursive: true, force: true })
cpSync(join(root, "scripts", "androidtui-repackage.mjs"), join(sourceRoot, "scripts", "androidtui-repackage.mjs"))
mkdirSync(join(sourceRoot, "patches"), { recursive: true })
cpSync(join(root, "patches", "apply-package-json.mjs"), join(sourceRoot, "patches", "apply-package-json.mjs"))
run("bun", ["patches/apply-package-json.mjs"], sourceRoot)

console.log(`Prepared OpenTUI ${manifest.upstream.tag} for ANDROIDTUI at ${sourceRoot}`)
