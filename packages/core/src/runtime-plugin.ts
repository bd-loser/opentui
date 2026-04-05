import { existsSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type BunPlugin } from "bun"
import * as coreRuntime from "./index.js"

export type RuntimeModuleExports = Record<string, unknown>
export type RuntimeModuleLoader = () => RuntimeModuleExports | Promise<RuntimeModuleExports>
export type RuntimeModuleEntry = RuntimeModuleExports | RuntimeModuleLoader

export interface RuntimePluginRewriteOptions {
  nodeModulesRuntimeSpecifiers?: boolean
  nodeModulesBareSpecifiers?: boolean
}

export interface CreateRuntimePluginOptions {
  core?: RuntimeModuleEntry
  additional?: Record<string, RuntimeModuleEntry>
  rewrite?: RuntimePluginRewriteOptions
}

const CORE_RUNTIME_SPECIFIER = "@opentui/core"
const CORE_TESTING_RUNTIME_SPECIFIER = "@opentui/core/testing"
const RUNTIME_MODULE_PREFIX = "opentui:runtime-module:"
const MAX_RUNTIME_RESOLVE_PARENTS = 64
const DEFAULT_RUNTIME_PLUGIN_REWRITE_OPTIONS: Required<RuntimePluginRewriteOptions> = {
  nodeModulesRuntimeSpecifiers: true,
  nodeModulesBareSpecifiers: false,
}

const DEFAULT_CORE_RUNTIME_MODULE_SPECIFIERS = [CORE_RUNTIME_SPECIFIER, CORE_TESTING_RUNTIME_SPECIFIER] as const

const DEFAULT_CORE_RUNTIME_MODULE_SPECIFIER_SET = new Set<string>(DEFAULT_CORE_RUNTIME_MODULE_SPECIFIERS)

export const isCoreRuntimeModuleSpecifier = (specifier: string): boolean => {
  return DEFAULT_CORE_RUNTIME_MODULE_SPECIFIER_SET.has(specifier)
}

const loadCoreTestingRuntimeModule = async (): Promise<RuntimeModuleExports> => {
  return (await import("./testing.js")) as RuntimeModuleExports
}

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const exactSpecifierFilter = (specifier: string): RegExp => {
  return new RegExp(`^${escapeRegExp(specifier)}$`)
}

const exactPathFilter = (path: string): RegExp => {
  const variants = new Set<string>([sourcePath(path), normalizeSourcePath(path)])

  for (const variant of [...variants]) {
    if (variant.startsWith("/var/")) {
      variants.add(`/private${variant}`)
    }

    if (variant.startsWith("/private/var/")) {
      variants.add(variant.slice("/private".length))
    }
  }

  return new RegExp(`^(?:${[...variants].map(escapeRegExp).join("|")})(?:[?#].*)?$`)
}

export const runtimeModuleIdForSpecifier = (specifier: string): string => {
  return `${RUNTIME_MODULE_PREFIX}${encodeURIComponent(specifier)}`
}

const resolveRuntimeModuleExports = async (moduleEntry: RuntimeModuleEntry): Promise<RuntimeModuleExports> => {
  if (typeof moduleEntry === "function") {
    return await moduleEntry()
  }

  return moduleEntry
}

const sourcePath = (path: string): string => {
  const searchIndex = path.indexOf("?")
  const hashIndex = path.indexOf("#")
  const end = [searchIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0]
  return end === undefined ? path : path.slice(0, end)
}

const normalizeSourcePath = (path: string): string => {
  const cleanPath = sourcePath(path)

  try {
    return realpathSync(cleanPath)
  } catch {
    return cleanPath
  }
}

const isNodeModulesPath = (path: string): boolean => {
  return /(?:^|[/\\])node_modules(?:[/\\])/.test(path)
}

const packageTypeByPackageJsonPath = new Map<string, "module" | "commonjs">()

const packageTypeForPath = (path: string): "module" | "commonjs" => {
  let currentDir = dirname(path)

  while (true) {
    const packageJsonPath = join(currentDir, "package.json")
    if (existsSync(packageJsonPath)) {
      const cachedPackageType = packageTypeByPackageJsonPath.get(packageJsonPath)
      if (cachedPackageType) {
        return cachedPackageType
      }

      let packageType: "module" | "commonjs" = "commonjs"

      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { type?: string }
        if (packageJson.type === "module") {
          packageType = "module"
        }
      } catch {
        packageType = "commonjs"
      }

      packageTypeByPackageJsonPath.set(packageJsonPath, packageType)
      return packageType
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return "commonjs"
    }

    currentDir = parentDir
  }
}

const isNodeModulesEsmPath = (path: string): boolean => {
  const normalizedPath = normalizeSourcePath(path)

  if (!isNodeModulesPath(normalizedPath)) {
    return false
  }

  if (
    normalizedPath.endsWith(".mjs") ||
    normalizedPath.endsWith(".mts") ||
    normalizedPath.endsWith(".ts") ||
    normalizedPath.endsWith(".tsx") ||
    normalizedPath.endsWith(".jsx")
  ) {
    return true
  }

  if (normalizedPath.endsWith(".cjs") || normalizedPath.endsWith(".cts") || !normalizedPath.endsWith(".js")) {
    return false
  }

  return packageTypeForPath(normalizedPath) === "module"
}

const nodeModulesPackageRootForPath = (path: string): string | null => {
  let currentDir = dirname(path)

  while (true) {
    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }

    if (basename(parentDir) === "node_modules") {
      return currentDir
    }

    if (basename(dirname(parentDir)) === "node_modules" && basename(parentDir).startsWith("@")) {
      return currentDir
    }

    currentDir = parentDir
  }
}

const resolveRuntimePluginRewriteOptions = (
  options: RuntimePluginRewriteOptions | undefined,
): Required<RuntimePluginRewriteOptions> => {
  return {
    nodeModulesRuntimeSpecifiers:
      options?.nodeModulesRuntimeSpecifiers ?? DEFAULT_RUNTIME_PLUGIN_REWRITE_OPTIONS.nodeModulesRuntimeSpecifiers,
    nodeModulesBareSpecifiers:
      options?.nodeModulesBareSpecifiers ?? DEFAULT_RUNTIME_PLUGIN_REWRITE_OPTIONS.nodeModulesBareSpecifiers,
  }
}

const runtimeLoaderForPath = (path: string): "js" | "ts" | "jsx" | "tsx" | null => {
  const cleanPath = sourcePath(path)

  if (cleanPath.endsWith(".tsx")) {
    return "tsx"
  }

  if (cleanPath.endsWith(".jsx")) {
    return "jsx"
  }

  if (cleanPath.endsWith(".ts") || cleanPath.endsWith(".mts") || cleanPath.endsWith(".cts")) {
    return "ts"
  }

  if (cleanPath.endsWith(".js") || cleanPath.endsWith(".mjs") || cleanPath.endsWith(".cjs")) {
    return "js"
  }

  return null
}

const resolveImportSpecifierPatterns = [
  /(from\s+["'])([^"']+)(["'])/g,
  /(import\s+["'])([^"']+)(["'])/g,
  /(import\s*\(\s*["'])([^"']+)(["']\s*\))/g,
  /(require\s*\(\s*["'])([^"']+)(["']\s*\))/g,
] as const

const isBareSpecifier = (specifier: string): boolean => {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\")) {
    return false
  }

  if (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("data:")
  ) {
    return false
  }

  if (specifier.startsWith(RUNTIME_MODULE_PREFIX)) {
    return false
  }

  return true
}

const registerResolveParent = (resolveParentsByRecency: string[], resolveParent: string): void => {
  const existingIndex = resolveParentsByRecency.indexOf(resolveParent)
  if (existingIndex >= 0) {
    resolveParentsByRecency.splice(existingIndex, 1)
  }

  resolveParentsByRecency.push(resolveParent)

  if (resolveParentsByRecency.length > MAX_RUNTIME_RESOLVE_PARENTS) {
    resolveParentsByRecency.shift()
  }
}

const rewriteImportSpecifiers = (code: string, resolveReplacement: (specifier: string) => string | null): string => {
  let transformedCode = code

  for (const pattern of resolveImportSpecifierPatterns) {
    transformedCode = transformedCode.replace(pattern, (fullMatch, prefix, specifier, suffix) => {
      const replacement = resolveReplacement(specifier)
      if (!replacement || replacement === specifier) {
        return fullMatch
      }

      return `${prefix}${replacement}${suffix}`
    })
  }

  return transformedCode
}

const collectImportSpecifiers = (code: string): string[] => {
  const specifiers = new Set<string>()

  for (const pattern of resolveImportSpecifierPatterns) {
    code.replace(pattern, (_fullMatch, _prefix, specifier) => {
      specifiers.add(specifier)
      return _fullMatch
    })
  }

  return [...specifiers]
}

const resolveFromParent = (specifier: string, parent: string): string | null => {
  try {
    const resolvedSpecifier = import.meta.resolve(specifier, parent)
    if (
      resolvedSpecifier === specifier ||
      resolvedSpecifier.startsWith("node:") ||
      resolvedSpecifier.startsWith("bun:")
    ) {
      return null
    }

    return resolvedSpecifier
  } catch {
    return null
  }
}

const resolveSourcePathFromSpecifier = (specifier: string, importer: string): string | null => {
  if (
    specifier.startsWith("node:") ||
    specifier.startsWith("bun:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    specifier.startsWith("data:") ||
    specifier.startsWith(RUNTIME_MODULE_PREFIX)
  ) {
    return null
  }

  if (specifier.startsWith("file:")) {
    return normalizeSourcePath(fileURLToPath(specifier))
  }

  if (isAbsolute(specifier)) {
    return normalizeSourcePath(specifier)
  }

  const resolvedSpecifier = resolveFromParent(specifier, importer)
  if (!resolvedSpecifier) {
    return null
  }

  if (resolvedSpecifier.startsWith("file:")) {
    return normalizeSourcePath(fileURLToPath(resolvedSpecifier))
  }

  if (isAbsolute(resolvedSpecifier)) {
    return normalizeSourcePath(resolvedSpecifier)
  }

  return null
}

const rewriteImportsFromResolveParents = (code: string, resolveParentsByRecency: string[]): string => {
  if (resolveParentsByRecency.length === 0) {
    return code
  }

  const resolveFromParents = (specifier: string): string | null => {
    if (!isBareSpecifier(specifier)) {
      return null
    }

    for (let index = resolveParentsByRecency.length - 1; index >= 0; index -= 1) {
      const resolveParent = resolveParentsByRecency[index]
      const resolvedSpecifier = resolveFromParent(specifier, resolveParent)
      if (resolvedSpecifier) {
        return resolvedSpecifier
      }
    }

    return null
  }

  return rewriteImportSpecifiers(code, resolveFromParents)
}

const rewriteRuntimeSpecifiers = (code: string, runtimeModuleIdsBySpecifier: Map<string, string>): string => {
  return rewriteImportSpecifiers(code, (specifier) => {
    const runtimeModuleId = runtimeModuleIdsBySpecifier.get(specifier)
    return runtimeModuleId ?? null
  })
}

export function createRuntimePlugin(input: CreateRuntimePluginOptions = {}): BunPlugin {
  const runtimeModules = new Map<string, RuntimeModuleEntry>()
  runtimeModules.set(CORE_RUNTIME_SPECIFIER, input.core ?? (coreRuntime as RuntimeModuleExports))
  runtimeModules.set(CORE_TESTING_RUNTIME_SPECIFIER, loadCoreTestingRuntimeModule)
  const rewriteOptions = resolveRuntimePluginRewriteOptions(input.rewrite)

  for (const [specifier, moduleEntry] of Object.entries(input.additional ?? {})) {
    runtimeModules.set(specifier, moduleEntry)
  }

  const runtimeModuleIdsBySpecifier = new Map<string, string>()
  for (const specifier of runtimeModules.keys()) {
    runtimeModuleIdsBySpecifier.set(specifier, runtimeModuleIdForSpecifier(specifier))
  }

  return {
    name: "bun-plugin-opentui-runtime-modules",
    setup: (build) => {
      const resolveParentsByRecency: string[] = []
      const installedRewriteLoaders = new Set<string>()
      const nodeModulesBareRewritePackageRoots = new Set<string>()
      const runtimeSpecifierRewriteNeededByPath = new Map<string, boolean>()
      const nodeModulesRuntimeRewritePathsByPath = new Map<string, string[]>()

      const installRewriteLoader = (path: string): void => {
        const normalizedPath = normalizeSourcePath(path)
        if (installedRewriteLoaders.has(normalizedPath)) {
          return
        }

        installedRewriteLoaders.add(normalizedPath)

        build.onLoad({ filter: exactPathFilter(normalizedPath) }, async (args) => {
          const path = normalizeSourcePath(args.path)
          const nodeModulesPath = isNodeModulesPath(path)
          const shouldRewriteRuntimeSpecifiers = !nodeModulesPath || rewriteOptions.nodeModulesRuntimeSpecifiers
          const shouldRewriteBareSpecifiers = !nodeModulesPath || rewriteOptions.nodeModulesBareSpecifiers
          const loader = runtimeLoaderForPath(args.path)

          if (!loader) {
            throw new Error(`Unable to determine runtime loader for path: ${args.path}`)
          }

          const contents = await Bun.file(path).text()
          const runtimeRewrittenContents = shouldRewriteRuntimeSpecifiers
            ? rewriteRuntimeSpecifiers(contents, runtimeModuleIdsBySpecifier)
            : contents

          if (runtimeRewrittenContents !== contents && shouldRewriteBareSpecifiers) {
            registerResolveParent(resolveParentsByRecency, path)
          }

          const transformedContents = shouldRewriteBareSpecifiers
            ? rewriteImportsFromResolveParents(runtimeRewrittenContents, resolveParentsByRecency)
            : runtimeRewrittenContents

          return {
            contents: transformedContents,
            loader,
          }
        })
      }

      const needsRuntimeSpecifierRewrite = (path: string): boolean => {
        const normalizedPath = normalizeSourcePath(path)
        const cached = runtimeSpecifierRewriteNeededByPath.get(normalizedPath)
        if (cached !== undefined) {
          return cached
        }

        const contents = readFileSync(normalizedPath, "utf8")
        const needsRewrite = rewriteRuntimeSpecifiers(contents, runtimeModuleIdsBySpecifier) !== contents
        runtimeSpecifierRewriteNeededByPath.set(normalizedPath, needsRewrite)
        return needsRewrite
      }

      const collectNodeModulesRuntimeRewritePaths = (path: string, visiting = new Set<string>()): string[] => {
        const normalizedPath = normalizeSourcePath(path)

        if (!isNodeModulesEsmPath(normalizedPath)) {
          return []
        }

        const cachedPaths = nodeModulesRuntimeRewritePathsByPath.get(normalizedPath)
        if (cachedPaths) {
          return cachedPaths
        }

        if (visiting.has(normalizedPath)) {
          return []
        }

        visiting.add(normalizedPath)

        const rewritePaths = new Set<string>()
        const contents = readFileSync(normalizedPath, "utf8")

        if (needsRuntimeSpecifierRewrite(normalizedPath)) {
          rewritePaths.add(normalizedPath)
        }

        for (const specifier of collectImportSpecifiers(contents)) {
          const resolvedPath = resolveSourcePathFromSpecifier(specifier, normalizedPath)
          if (!resolvedPath || !isNodeModulesEsmPath(resolvedPath)) {
            continue
          }

          for (const nestedPath of collectNodeModulesRuntimeRewritePaths(resolvedPath, visiting)) {
            rewritePaths.add(nestedPath)
          }
        }

        visiting.delete(normalizedPath)

        const resolvedRewritePaths = [...rewritePaths]
        nodeModulesRuntimeRewritePathsByPath.set(normalizedPath, resolvedRewritePaths)
        return resolvedRewritePaths
      }

      for (const [specifier, moduleEntry] of runtimeModules.entries()) {
        const moduleId = runtimeModuleIdsBySpecifier.get(specifier)

        if (!moduleId) {
          continue
        }

        build.module(moduleId, async () => ({
          exports: await resolveRuntimeModuleExports(moduleEntry),
          loader: "object",
        }))

        build.onResolve({ filter: exactSpecifierFilter(specifier) }, () => ({ path: moduleId }))
      }

      build.onResolve({ filter: /.*/ }, (args) => {
        if (runtimeModuleIdsBySpecifier.has(args.path) || args.path.startsWith(RUNTIME_MODULE_PREFIX)) {
          return undefined
        }

        const path = resolveSourcePathFromSpecifier(args.path, args.importer)
        if (!path || !runtimeLoaderForPath(path)) {
          return undefined
        }

        const nodeModulesPath = isNodeModulesPath(path)

        if (!nodeModulesPath) {
          installRewriteLoader(path)
          return undefined
        }

        if (!rewriteOptions.nodeModulesRuntimeSpecifiers && !rewriteOptions.nodeModulesBareSpecifiers) {
          return undefined
        }

        for (const rewritePath of collectNodeModulesRuntimeRewritePaths(path)) {
          installRewriteLoader(rewritePath)
        }

        const packageRoot = nodeModulesPackageRootForPath(path)
        if (rewriteOptions.nodeModulesBareSpecifiers && packageRoot && nodeModulesBareRewritePackageRoots.has(packageRoot)) {
          installRewriteLoader(path)
          return undefined
        }

        if (!rewriteOptions.nodeModulesRuntimeSpecifiers || !needsRuntimeSpecifierRewrite(path)) {
          return undefined
        }

        if (rewriteOptions.nodeModulesBareSpecifiers && packageRoot) {
          nodeModulesBareRewritePackageRoots.add(packageRoot)
        }

        installRewriteLoader(path)
        return undefined
      })
    },
  }
}
