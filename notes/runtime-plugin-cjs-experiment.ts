import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const tempRoot = mkdtempSync(join(tmpdir(), "opentui-runtime-plugin-cjs-experiment-"))
const packageRoot = join(tempRoot, "app")
const externalPackageDir = join(packageRoot, "node_modules", "runtime-plugin-cjs-fixture")
const externalPackageEntryPath = join(externalPackageDir, "index.js")
const repoRoot = join(import.meta.dir, "..")
const solidPackageRoot = join(repoRoot, "packages", "solid")
const entryRoot = join(solidPackageRoot, ".runtime-plugin-cjs-experiment")

const installDependency = (cwd: string, packageName: string): void => {
  const result = Bun.spawnSync(["bun", "add", packageName], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  if (result.exitCode !== 0) {
    throw new Error(
      [`Failed to install ${packageName}`, result.stdout.toString(), result.stderr.toString()].filter(Boolean).join("\n"),
    )
  }
}

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const runImport = (label: string, script: string): void => {
  mkdirSync(entryRoot, { recursive: true })
  const entryPath = join(entryRoot, `${label}.ts`)
  writeFileSync(entryPath, script)

  const result = Bun.spawnSync([process.execPath, entryPath], {
    cwd: solidPackageRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })

  console.log(`scenario=${label}`)
  console.log(`exitCode=${result.exitCode}`)

  const stdout = result.stdout.toString().trim()
  if (stdout) {
    console.log(`stdout=${JSON.stringify(stdout)}`)
  }

  const stderr = result.stderr.toString().trim()
  if (stderr) {
    console.log(`stderr=${JSON.stringify(stderr)}`)
  }

  console.log("---")
}

writeJson(join(packageRoot, "package.json"), {
  name: "runtime-plugin-cjs-experiment",
  private: true,
  type: "module",
})

installDependency(packageRoot, "jsonc-parser@3.3.1")
installDependency(packageRoot, "@tarquinen/opencode-dcp@3.1.4")

writeJson(join(externalPackageDir, "package.json"), {
  name: "runtime-plugin-cjs-fixture",
  private: true,
  type: "module",
  exports: "./index.js",
})

writeFileSync(
  externalPackageEntryPath,
  [
    'import { parse } from "jsonc-parser"',
    'export const parsed = parse("{\\"value\\":1}")',
    'console.log(`fixture-value=${parsed.value}`)',
  ].join("\n"),
)

const jsoncParserPackagePath = join(packageRoot, "node_modules", "jsonc-parser", "package.json")
const jsoncParserPackage = JSON.parse(readFileSync(jsoncParserPackagePath, "utf8")) as {
  main?: string
  module?: string
}

const resolveScript = `
const externalEntryUrl = ${JSON.stringify(pathToFileURL(externalPackageEntryPath).href)}
console.log('resolved=' + import.meta.resolve('jsonc-parser', externalEntryUrl))
`

const withoutRuntimePluginScript = `
await import(${JSON.stringify(pathToFileURL(externalPackageEntryPath).href)})
`

const withRuntimePluginScript = `
await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "packages", "solid", "scripts", "runtime-plugin-support.ts")).href)})
await import(${JSON.stringify(pathToFileURL(externalPackageEntryPath).href)})
`

const realPackageWithoutRuntimePluginScript = `
const mod = await import(${JSON.stringify(
  pathToFileURL(join(packageRoot, "node_modules", "@tarquinen", "opencode-dcp", "dist", "index.js")).href,
)})
console.log('default-export=' + typeof mod.default)
`

const realPackageWithRuntimePluginScript = `
await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "packages", "solid", "scripts", "runtime-plugin-support.ts")).href)})
const mod = await import(${JSON.stringify(
  pathToFileURL(join(packageRoot, "node_modules", "@tarquinen", "opencode-dcp", "dist", "index.js")).href,
)})
console.log('default-export=' + typeof mod.default)
`

try {
  console.log(`jsonc-parser.main=${jsoncParserPackage.main ?? ""}`)
  console.log(`jsonc-parser.module=${jsoncParserPackage.module ?? ""}`)
  console.log("---")

  runImport("resolve", resolveScript)
  runImport("without-runtime-plugin-support", withoutRuntimePluginScript)
  runImport("with-runtime-plugin-support", withRuntimePluginScript)
  runImport("real-package-without-runtime-plugin-support", realPackageWithoutRuntimePluginScript)
  runImport("real-package-with-runtime-plugin-support", realPackageWithRuntimePluginScript)
} finally {
  rmSync(entryRoot, { recursive: true, force: true })
  rmSync(tempRoot, { recursive: true, force: true })
}
