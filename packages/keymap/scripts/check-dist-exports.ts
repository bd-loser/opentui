import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

interface DistPackageJson {
  exports?: Record<string, { import?: string }>
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const distDir = resolve(rootDir, "dist")

const distPackageJson = JSON.parse(readFileSync(resolve(distDir, "package.json"), "utf8")) as DistPackageJson

const expectedExports = [".", "./addons", "./addons/opentui", "./html", "./opentui"] as const

for (const exportName of expectedExports) {
  const entry = distPackageJson.exports?.[exportName]
  if (!entry?.import) {
    throw new Error(`Missing dist export: ${exportName}`)
  }

  const filePath = resolve(distDir, entry.import)
  if (!existsSync(filePath)) {
    throw new Error(`Missing dist export file for ${exportName}: ${filePath}`)
  }

  await import(pathToFileURL(filePath).href)
}

console.log("Verified dist export entrypoints:", expectedExports.join(", "))
