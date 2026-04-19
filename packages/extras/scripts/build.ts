import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

interface PackageJson {
  name: string
  version: string
  license?: string
  repository?: unknown
  description?: string
  homepage?: string
  author?: string
  bugs?: unknown
  keywords?: string[]
  module?: string
  main?: string
  types?: string
  type?: string
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const projectRootDir = resolve(rootDir, "../..")
const licensePath = join(projectRootDir, "LICENSE")
const packageJson: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

const isCi = process.argv.slice(2).includes("--ci")

const replaceLinks = (text: string): string => {
  return packageJson.homepage
    ? text.replace(
        /(\[.*?\]\()(\.\/.*?\))/g,
        (_, p1: string, p2: string) => `${p1}${packageJson.homepage}/blob/HEAD/${p2.replace("./", "")}`,
      )
    : text
}

const requiredFields: (keyof PackageJson)[] = ["name", "version", "description"]
const missingRequired = requiredFields.filter((field) => !packageJson[field])
if (missingRequired.length > 0) {
  console.error(`Error: Missing required fields in package.json: ${missingRequired.join(", ")}`)
  process.exit(1)
}

if (!packageJson.module) {
  console.error("Error: 'module' field not found in package.json")
  process.exit(1)
}

console.log("Building @opentui/extras library...")

const distDir = join(rootDir, "dist")
rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

const externalDeps: string[] = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {}),
]

const keymapEntrypoints = [
  join(rootDir, "keymap/index.ts"),
  join(rootDir, "keymap/html.ts"),
  join(rootDir, "keymap/opentui.ts"),
  join(rootDir, "keymap/react/index.ts"),
  join(rootDir, "keymap/solid/index.ts"),
]

const buildResult = await Bun.build({
  entrypoints: [join(rootDir, packageJson.module), ...keymapEntrypoints],
  target: "bun",
  format: "esm",
  outdir: distDir,
  external: externalDeps,
})

if (!buildResult.success) {
  console.error("Build failed:", buildResult.logs)
  process.exit(1)
}

console.log("Generating TypeScript declarations...")

const tsconfigBuildPath = join(rootDir, "tsconfig.build.json")
const tscResult: SpawnSyncReturns<Buffer> = spawnSync("bunx", ["tsc", "-p", tsconfigBuildPath], {
  cwd: rootDir,
  stdio: "inherit",
})

if (tscResult.status !== 0) {
  if (isCi) {
    console.error("Error: TypeScript declaration generation failed")
    process.exit(1)
  }

  console.warn("Warning: TypeScript declaration generation failed")
} else {
  console.log("TypeScript declarations generated")
}

const exports = {
  ".": {
    types: "./index.d.ts",
    import: "./index.js",
    require: "./index.js",
  },
  "./keymap": {
    types: "./keymap/index.d.ts",
    import: "./keymap/index.js",
    require: "./keymap/index.js",
  },
  "./keymap/html": {
    types: "./keymap/html.d.ts",
    import: "./keymap/html.js",
    require: "./keymap/html.js",
  },
  "./keymap/opentui": {
    types: "./keymap/opentui.d.ts",
    import: "./keymap/opentui.js",
    require: "./keymap/opentui.js",
  },
  "./keymap/react": {
    types: "./keymap/react/index.d.ts",
    import: "./keymap/react/index.js",
    require: "./keymap/react/index.js",
  },
  "./keymap/solid": {
    types: "./keymap/solid/index.d.ts",
    import: "./keymap/solid/index.js",
    require: "./keymap/solid/index.js",
  },
}

writeFileSync(
  join(distDir, "package.json"),
  JSON.stringify(
    {
      name: packageJson.name,
      module: "index.js",
      main: "index.js",
      types: "index.d.ts",
      type: packageJson.type,
      version: packageJson.version,
      description: packageJson.description,
      keywords: packageJson.keywords,
      license: packageJson.license,
      author: packageJson.author,
      homepage: packageJson.homepage,
      repository: packageJson.repository,
      bugs: packageJson.bugs,
      exports,
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
      peerDependencies: packageJson.peerDependencies,
      peerDependenciesMeta: packageJson.peerDependenciesMeta,
    },
    null,
    2,
  ),
)

const readmePath = join(rootDir, "README.md")
if (existsSync(readmePath)) {
  writeFileSync(join(distDir, "README.md"), replaceLinks(readFileSync(readmePath, "utf8")))
} else {
  console.warn("Warning: README.md not found in extras package")
}

if (existsSync(licensePath)) {
  copyFileSync(licensePath, join(distDir, "LICENSE"))
} else {
  console.warn("Warning: LICENSE file not found in project root")
}

console.log("Library built at:", distDir)
