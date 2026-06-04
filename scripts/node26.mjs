import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const NODE26_VERSION = "v26.3.0"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..")
const cacheDir = resolve(repoRoot, ".cache/node26")

function getTarget() {
  const arch = getNodeDownloadArch()

  switch (process.platform) {
    case "linux":
      return {
        archiveName: `node-${NODE26_VERSION}-linux-${arch}.tar.xz`,
        directoryName: `node-${NODE26_VERSION}-linux-${arch}`,
        nodeRelativePath: "bin/node",
        url: `https://nodejs.org/dist/${NODE26_VERSION}/node-${NODE26_VERSION}-linux-${arch}.tar.xz`,
      }
    case "darwin":
      return {
        archiveName: `node-${NODE26_VERSION}-darwin-${arch}.tar.gz`,
        directoryName: `node-${NODE26_VERSION}-darwin-${arch}`,
        nodeRelativePath: "bin/node",
        url: `https://nodejs.org/dist/${NODE26_VERSION}/node-${NODE26_VERSION}-darwin-${arch}.tar.gz`,
      }
    case "win32":
      return {
        archiveName: `node-${NODE26_VERSION}-win-${arch}.zip`,
        directoryName: `node-${NODE26_VERSION}-win-${arch}`,
        nodeRelativePath: "node.exe",
        url: `https://nodejs.org/dist/${NODE26_VERSION}/node-${NODE26_VERSION}-win-${arch}.zip`,
      }
    default:
      throw new Error(`This repo Node 26 runner does not have a download for ${process.platform}-${process.arch}.`)
  }
}

function getNodeDownloadArch() {
  switch (process.arch) {
    case "x64":
    case "arm64":
      return process.arch
    default:
      throw new Error(`This repo Node 26 runner does not have a download for ${process.platform}-${process.arch}.`)
  }
}

export function getNode26Path() {
  const target = getTarget()
  return resolve(cacheDir, target.directoryName, target.nodeRelativePath)
}

export function ensureNode26() {
  const target = getTarget()
  const archivePath = resolve(cacheDir, target.archiveName)
  const nodeDir = resolve(cacheDir, target.directoryName)
  const nodePath = resolve(nodeDir, target.nodeRelativePath)

  if (existsSync(nodePath)) {
    return nodePath
  }

  mkdirSync(cacheDir, { recursive: true })

  if (!existsSync(archivePath)) {
    run("curl", ["-L", target.url, "-o", archivePath])
  }

  extractArchive(archivePath, cacheDir)

  if (!existsSync(nodePath)) {
    throw new Error(`Downloaded Node 26 archive did not produce ${nodePath}`)
  }

  return nodePath
}

function extractArchive(archivePath, outputDir) {
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${outputDir}' -Force`,
      ])
      return
    }

    run("unzip", ["-q", archivePath, "-d", outputDir])
    return
  }

  run("tar", ["-xf", archivePath, "-C", outputDir])
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
