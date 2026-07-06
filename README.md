# OpenTUI (XINCLI Fork)

> **This is the XINCLI fork of OpenTUI** — adds Android/Termux support via
> native builds + `@xincli` npm scope. Upstream is at
> [anomalyco/opentui](https://github.com/anomalyco/opentui).

<div align="center">
    <a href="https://www.npmjs.com/package/@xincli/opentui-core"><img alt="npm" src="https://img.shields.io/npm/v/@xincli/opentui-core?style=flat-square&label=%40xincli%2Fopentui-core" /></a>
    <a href="https://www.npmjs.com/package/@xincli/opentui-react"><img alt="npm" src="https://img.shields.io/npm/v/@xincli/opentui-react?style=flat-square&label=%40xincli%2Fopentui-react" /></a>
    <a href="https://www.npmjs.com/package/@xincli/opentui-core-android-arm64"><img alt="npm" src="https://img.shields.io/npm/v/@xincli/opentui-core-android-arm64?style=flat-square&label=android-arm64+.so" /></a>
</div>

OpenTUI is a native terminal UI core written in Zig with TypeScript bindings. The native core exposes a C ABI and can be used from any language. OpenTUI powers [OpenCode](https://opencode.ai) in production today and will also power [terminal.shop](https://terminal.shop). It is an extensible core with a focus on correctness, stability, and high performance. It provides a component-based architecture with flexible layout capabilities, allowing you to create complex terminal applications.

Upstream docs: https://opentui.com/docs/getting-started

## XINCLI Fork — What Changed

This fork adds **Android/Termux support** to opentui:

1. **`packages/core/src/zig/build.zig`** — added `aarch64-linux-android` target
2. **`packages/core/src/zig.ts`** — patched `resolveNativePackage()` with `android` branch that loads `@xincli/opentui-core-android-*`
3. **`packages/core/scripts/build-native-termux.sh`** — native build script (builds `.so` on a real phone, no cross-compilation)
4. **`packages/core/scripts/package-prebuilt.ts`** — packages `.so` into npm dirs with `index.js` wrapper
5. **`.github/workflows/package-prebuilt.yml`** — CI workflow that publishes the `.so` package
6. **`.github/workflows/publish-js-library.yml`** — CI workflow that builds + publishes the compiled JS library

### Published npm packages

| Package | Version | Purpose |
|---|---|---|
| `@xincli/opentui-core` | 0.4.7 | Compiled opentui core JS library (works under Node 26.3+ or Bun) |
| `@xincli/opentui-react` | 0.4.7 | Compiled opentui React reconciler |
| `@xincli/opentui-core-android-arm64` | 0.4.7 | Native `libopentui.so` for Android arm64 (Termux) |

## Install

### For XINCLI / Android / Termux (Node.js 26.3+)

```bash
npm install \
  @xincli/opentui-core@0.4.7 \
  @xincli/opentui-react@0.4.7 \
  @xincli/opentui-core-android-arm64@0.4.7 \
  react@19.2.0 react-reconciler@0.33.0 \
  react-devtools-core@7.0.1 ws@8.18.0 \
  --legacy-peer-deps

# Run with FFI enabled (Node 26.3+ required)
node --experimental-ffi your-app.mjs
```

### For upstream platforms (macOS/Linux/Windows, Bun)

NOTE: You must have [Zig](https://ziglang.org/learn/getting-started/) installed on your system to build the packages.

```bash
bun install @opentui/core
```

## Documentation

### XINCLI Fork Docs (in this repo)

- **[OPENTUI_TERMUX.md](OPENTUI_TERMUX.md)** — **The deep-dive.** How opentui renders on Termux, 14 critical problems & solutions, build pipelines, restart guide. Read this first if you're picking up the XINCLI opentui work.
- **[NATIVE_BUILD.md](NATIVE_BUILD.md)** — How to build `libopentui.so` natively on Termux (the 70-iteration journey from cross-compilation hell to native builds)
- **[packages/core/README.md](packages/core/README.md)** — Package-level install + usage + step-by-step "how it works on Android" diagram
- **[packages/react/README.md](packages/react/README.md)** — React binding package docs

### Upstream Docs

- [Website docs](https://opentui.com/docs/getting-started) — Guides and API references
- [Development Guide](packages/core/docs/development.md) — Building, testing, and local dev linking
- [Getting Started](packages/core/docs/getting-started.md) — API and usage guide
- [Environment Variables](packages/core/docs/env-vars.md) — Configuration options

### XINCLI App Repo

- **[Clagit](https://github.com/bd-loser/Clagit)** — The XINCLI app that consumes these packages. Has a dual-runtime launcher (`bin/xincli`) that auto-detects Node 26.3+ and runs the opentui UI, falling back to Ink on older Node.

## AI Agent Skill

Teach your AI coding assistant OpenTUI's APIs and patterns.

**Universal skill install with [`npx skills`](https://skills.sh):**

```bash
npx skills add anomalyco/opentui --skill opentui
```

Install globally for every project:

```bash
npx skills add anomalyco/opentui --skill opentui -g
```

OpenCode uses the same install command. No separate installer is needed.

## Try Examples

You can quickly try out OpenTUI examples without cloning the repository:

**For macOS, Linux, WSL, Git Bash:**

```bash
curl -fsSL https://raw.githubusercontent.com/anomalyco/opentui/main/packages/examples/install.sh | sh
```

**For Windows (PowerShell/CMD):**

Download the latest release directly from [GitHub Releases](https://github.com/anomalyco/opentui/releases/latest)

## Running Examples (from the repo root)

### TypeScript Examples

```bash
bun install
cd packages/examples
bun run dev
```

## Development

See the [Development Guide](packages/core/docs/development.md) for building, testing, debugging, and local development linking.

### Documentation

- [Website docs](https://opentui.com/docs/getting-started) - Guides and API references
- [Development Guide](packages/core/docs/development.md) - Building, testing, and local dev linking
- [Getting Started](packages/core/docs/getting-started.md) - API and usage guide
- [Environment Variables](packages/core/docs/env-vars.md) - Configuration options

## Showcase

Consider showcasing your work on the [awesome-opentui](https://github.com/msmps/awesome-opentui) list. A curated list of awesome resources and terminal user interfaces built with OpenTUI.
