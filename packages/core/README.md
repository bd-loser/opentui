# OpenTUI Core (XINCLI Fork)

> **This is the XINCLI fork of OpenTUI** with Android/Termux support added.
> Upstream opentui doesn't support Android — this fork adds:
> - `aarch64-linux-android` build target in `src/zig/build.zig`
> - `android` branch in `resolveNativePackage()` (loads `@xincli/opentui-core-android-*`)
> - Native Termux build script (`scripts/build-native-termux.sh`)
> - npm packages published under the `@xincli` scope

OpenTUI is a native terminal UI core written in Zig with TypeScript bindings. The native core exposes a C ABI and can be used from any language. OpenTUI powers OpenCode in production today and will also power terminal.shop. It is an extensible core with a focus on correctness, stability, and high performance. It provides a component-based architecture with flexible layout capabilities, allowing you to create complex terminal applications.

## Documentation

- [Getting Started](docs/getting-started.md) - API and usage guide
- [Development Guide](docs/development.md) - Building, testing, and contributing
- [Tree-Sitter](docs/tree-sitter.md) - Syntax highlighting integration
- [Renderables vs Constructs](docs/renderables-vs-constructs.md) - Understanding the component model
- [Environment Variables](docs/env-vars.md) - Configuration options
- **[NATIVE_BUILD.md](../../NATIVE_BUILD.md)** — How to build `libopentui.so` natively on Termux
- **[Clagit docs/OPENTUI_TERMUX.md](https://github.com/bd-loser/Clagit/blob/main/docs/OPENTUI_TERMUX.md)** — Deep-dive on the full XINCLI opentui stack

## Install

### For XINCLI (Android/Termux)

```bash
npm install @xincli/opentui-core@0.4.7 \
  @xincli/opentui-core-android-arm64@0.4.7 \
  --legacy-peer-deps
```

The `@xincli/opentui-core` package is the compiled JS library. The
`@xincli/opentui-core-android-arm64` package contains the native
`libopentui.so` binary built natively on Termux.

### For upstream (macOS/Linux/Windows)

```bash
bun install @opentui/core
```

## Runtime requirements (Android)

- **Node.js 26.3.0+** with `--experimental-ffi` flag (opentui uses `node:ffi`)
- Or **Bun** (uses `bun:ffi`, no flags needed)

```bash
# On Termux:
pkg upgrade nodejs  # gets Node 26.x
node --experimental-ffi your-app.mjs
```

## How it works on Android

```
your-app.mjs
  ↓  import { createCliRenderer } from '@xincli/opentui-core'
@xincli/opentui-core (compiled JS)
  ↓  resolveNativePackage() detects process.platform === 'android'
  ↓  await import('@xincli/opentui-core-android-arm64')
@xincli/opentui-core-android-arm64
  ↓  index.js exports the .so path string
  ↓  dlopen(libopentui.so) via node:ffi
libopentui.so (12 MB ARM64 ELF, built natively on Termux)
  ↓  Zig core: yoga layout, cell buffering, ANSI output
  ↓  takes over stdout, 30 FPS render loop
Terminal renders 🎉
```

See [Clagit docs/OPENTUI_TERMUX.md](https://github.com/bd-loser/Clagit/blob/main/docs/OPENTUI_TERMUX.md)
for the full deep-dive including all 14 critical problems we solved.

## Build

```bash
bun run build
```

This creates platform-specific libraries that are automatically loaded by the TypeScript layer.

## Examples

```bash
bun install
cd ../examples
bun run dev
```

## Benchmarks

Run native performance benchmarks:

```bash
bun run bench:native
```

See [src/zig/bench.zig](src/zig/bench.zig) for available options like `--filter` and `--mem`.

NativeSpanFeed TypeScript benchmarks:

- [src/benchmark/native-span-feed-benchmark.md](src/benchmark/native-span-feed-benchmark.md)

## CLI Renderer

### Renderables

Renderables are hierarchical objects that can be positioned, nested, styled and rendered to the terminal:

```typescript
import { createCliRenderer, TextRenderable } from "@opentui/core"

const renderer = await createCliRenderer()

const obj = new TextRenderable(renderer, { id: "my-obj", content: "Hello, world!" })

renderer.root.add(obj)
```
