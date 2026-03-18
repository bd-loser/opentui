import { transformAsync } from "@babel/core"
import { readFile } from "node:fs/promises"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import moduleResolver from "babel-plugin-module-resolver"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"
import { type BunPlugin } from "bun"

export type ResolveImportPath = (specifier: string) => string | null

const runtimeTransformKey = "__opentuiSolidRuntimeTransform__"

type RuntimeTransform = {
  moduleName?: string
  resolvePath?: ResolveImportPath
}

type RuntimeTransformState = typeof globalThis & {
  [runtimeTransformKey]?: RuntimeTransform
}

export interface CreateSolidTransformPluginOptions {
  moduleName?: string
  resolvePath?: ResolveImportPath
}

const runtimeTransform = (): RuntimeTransform => {
  return (globalThis as RuntimeTransformState)[runtimeTransformKey] ?? {}
}

export function configureRuntimeTransform(input?: RuntimeTransform): void {
  const state = globalThis as RuntimeTransformState

  if (!input) {
    delete state[runtimeTransformKey]
    return
  }

  state[runtimeTransformKey] = input
}

export function createSolidTransformPlugin(input: CreateSolidTransformPluginOptions = {}): BunPlugin {
  return {
    name: "bun-plugin-solid",
    setup: (build) => {
      build.onLoad({ filter: /[\/\\]node_modules[\/\\]solid-js[\/\\]dist[\/\\]server\.js$/ }, async (args) => {
        const path = args.path.replace("server.js", "solid.js")
        const file = Bun.file(path)
        const code = await file.text()
        return { contents: code, loader: "js" }
      })

      build.onLoad(
        { filter: /[\/\\]node_modules[\/\\]solid-js[\/\\]store[\/\\]dist[\/\\]server\.js$/ },
        async (args) => {
          const path = args.path.replace("server.js", "store.js")
          const file = Bun.file(path)
          const code = await file.text()
          return { contents: code, loader: "js" }
        },
      )

      build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
        const file = Bun.file(args.path)
        const code = await file.text()
        const runtime = runtimeTransform()
        const moduleName = input.moduleName ?? runtime.moduleName ?? "@opentui/solid"
        const resolvePath = input.resolvePath ?? runtime.resolvePath
        const plugins = resolvePath
          ? [
              [
                moduleResolver,
                {
                  resolvePath(specifier: string) {
                    return resolvePath(specifier) ?? specifier
                  },
                },
              ],
            ]
          : []

        const transforms = await transformAsync(code, {
          filename: args.path,
          plugins,
          presets: [
            [
              solid,
              {
                moduleName,
                generate: "universal",
              },
            ],
            [ts],
          ],
        })

        return {
          contents: transforms?.code ?? "",
          loader: "js",
        }
      })
    },
  }
}

const solidTransformPlugin = createSolidTransformPlugin()

export default solidTransformPlugin
