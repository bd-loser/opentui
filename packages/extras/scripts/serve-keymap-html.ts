import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, extname, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")
const distDir = resolve(rootDir, "dist")
const exampleDir = resolve(rootDir, "examples/keymap-html")
const indexHtmlPath = resolve(exampleDir, "index.html")
const stylesPath = resolve(exampleDir, "styles.css")
const appSourcePath = resolve(exampleDir, "app.ts")

function parsePort(argv: string[]): number {
  const portArg = argv.find((arg) => arg.startsWith("--port="))
  if (!portArg) {
    return 3210
  }

  const value = Number.parseInt(portArg.slice("--port=".length), 10)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid port: ${portArg}`)
  }

  return value
}

function ensureBuiltDist(): void {
  const result = spawnSync("bun", ["run", "build"], {
    cwd: rootDir,
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function getContentType(pathname: string): string {
  const extension = extname(pathname).toLowerCase()
  if (extension === ".html") {
    return "text/html; charset=utf-8"
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8"
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8"
  }

  if (extension === ".json") {
    return "application/json; charset=utf-8"
  }

  return "application/octet-stream"
}

function createNotFoundResponse(pathname: string): Response {
  return new Response(`Not found: ${pathname}`, {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  })
}

function createFileResponse(path: string): Response {
  if (!existsSync(path)) {
    return createNotFoundResponse(path)
  }

  return new Response(Bun.file(path), {
    headers: {
      "cache-control": "no-store",
      "content-type": getContentType(path),
    },
  })
}

async function createAppResponse(): Promise<Response> {
  const content = await Bun.file(appSourcePath).text()
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  return new Response(transpiler.transformSync(content), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
    },
  })
}

function resolveDistPath(pathname: string): string | null {
  const relativePath = pathname.slice("/dist/".length)
  const resolvedPath = resolve(distDir, relativePath)
  if (!resolvedPath.startsWith(distDir)) {
    return null
  }

  return resolvedPath
}

ensureBuiltDist()

const port = parsePort(process.argv.slice(2))

const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url)
    const pathname = url.pathname

    if (pathname === "/" || pathname === "/index.html") {
      return createFileResponse(indexHtmlPath)
    }

    if (pathname === "/styles.css") {
      return createFileResponse(stylesPath)
    }

    if (pathname === "/app.js") {
      return createAppResponse()
    }

    if (pathname.startsWith("/dist/")) {
      const distPath = resolveDistPath(pathname)
      if (!distPath) {
        return new Response("Forbidden", { status: 403 })
      }

      return createFileResponse(distPath)
    }

    return createNotFoundResponse(pathname)
  },
})

console.log(`HTML keymap demo running at http://localhost:${server.port}`)
console.log("Try Space then s/h/r, :help, :reset, and Tab / Shift+Tab")
