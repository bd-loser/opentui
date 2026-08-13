# ANDROIDTUI

<div align="center">
  <strong>OpenTUI for Android and Termux</strong>
  <br />
  Native Zig rendering with TypeScript, React, and SolidJS bindings.
  <br /><br />
  <a href="https://www.npmjs.com/package/@androidtui/core"><img alt="ANDROIDTUI core on npm" src="https://img.shields.io/npm/v/@androidtui/core?style=flat-square&label=%40androidtui%2Fcore" /></a>
  <a href="https://github.com/bd-loser/opentui/actions/workflows/androidtui-release.yml"><img alt="ANDROIDTUI release status" src="https://img.shields.io/github/actions/workflow/status/bd-loser/opentui/androidtui-release.yml?style=flat-square&label=release" /></a>
  <a href="https://github.com/bd-loser/opentui/blob/main/LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-2f855a?style=flat-square" /></a>
</div>

ANDROIDTUI is the Android compatibility distribution of [OpenTUI](https://github.com/anomalyco/opentui). It enables native terminal user interfaces on Android through [Termux](https://termux.dev), with an ARM64 native library built against Android's Bionic libc.

This repository is intentionally a small compatibility layer. It does not duplicate OpenTUI's source tree. A pinned upstream release is cloned into `.work/opentui`, the focused Android patches are applied, and additive Android files are copied from `overlay/`.

Use ANDROIDTUI to build fast terminal applications for Android with OpenTUI's imperative API, React reconciler, SolidJS reconciler, Yoga layout, terminal input handling, and Tree-sitter syntax highlighting.

## Install on Termux

Install the core package with Bun:

```bash
bun add @androidtui/core
```

For React applications:

```bash
bun add @androidtui/core @androidtui/react react
```

For SolidJS applications:

```bash
bun add @androidtui/core @androidtui/solid solid-js
```

The Android ARM64 native package, `@androidtui/core-android-arm64`, is installed automatically as an optional dependency of `@androidtui/core`.

## Quick Start

```ts
import { createCliRenderer, TextRenderable } from "@androidtui/core"

const renderer = await createCliRenderer()
const text = new TextRenderable(renderer, {
  id: "hello",
  content: "Hello from Android and Termux",
})

renderer.root.add(text)
```

ANDROIDTUI supports Bun on Termux. The Node.js path requires a Node release that provides `node:ffi` and must be started with `--experimental-ffi`. See [OpenTUI on Termux](OPENTUI_TERMUX.md) for runtime details and troubleshooting.

## Packages

| Package                                                                                          | Purpose                                             |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| [`@androidtui/core`](https://www.npmjs.com/package/@androidtui/core)                             | OpenTUI core with Android native package resolution |
| [`@androidtui/core-android-arm64`](https://www.npmjs.com/package/@androidtui/core-android-arm64) | Native ARM64 Android library for Termux             |
| [`@androidtui/react`](https://www.npmjs.com/package/@androidtui/react)                           | React renderer for Android terminal applications    |
| [`@androidtui/solid`](https://www.npmjs.com/package/@androidtui/solid)                           | SolidJS renderer for Android terminal applications  |
| [`@androidtui/keymap`](https://www.npmjs.com/package/@androidtui/keymap)                         | Commands, keybindings, and key sequence handling    |

Source packages retain their upstream `@opentui/*` workspace names. Release tooling publishes Android-compatible distributions under the `@androidtui/*` npm scope.

## Android Support

| Environment               | Status                              |
| ------------------------- | ----------------------------------- |
| Android ARM64 with Termux | Supported                           |
| Bun on Termux             | Supported                           |
| Node.js with `node:ffi`   | Supported with `--experimental-ffi` |
| Android ARMv7             | Not currently published             |
| Android x86_64            | Not currently published             |

The native library is built inside a real ARM64 Termux userspace using `termux/termux-docker:aarch64`. The workflow runs on an ARM64 GitHub runner, applies the pinned patches inside Termux, and uploads `libopentui.so`, its checksum, and build metadata. This is a native Bionic build, not a glibc cross-compile.

## Documentation

- [OpenTUI on Android and Termux](OPENTUI_TERMUX.md): architecture, runtime selection, package layout, and troubleshooting
- [Native Android build](NATIVE_BUILD.md): build `libopentui.so` directly in Termux
- [Patch kit maintenance](patches/README.md): port Android support to a new upstream OpenTUI release
- [Upstream OpenTUI documentation](https://opentui.com/docs/getting-started): APIs, components, and core concepts

## Repository Architecture

| Path | Purpose |
| --- | --- |
| `androidtui.json` | Pins the exact upstream OpenTUI tag and commit |
| `patches/` | Ordered patches that modify existing upstream files |
| `overlay/` | Android-specific files that do not exist upstream |
| `scripts/prepare.mjs` | Creates a disposable patched OpenTUI checkout |
| `scripts/verify.mjs` | Verifies the pin, patches, overlay, and package versions |
| `ci/` | Runs the native build inside the Termux container |
| `.work/opentui/` | Generated upstream source tree; never committed |

## Maintainer Workflow

Create a clean Android-enabled OpenTUI source tree:

```bash
npm run prepare:upstream
npm run verify
```

Build the native library locally from the generated checkout on Termux:

```bash
cd .work/opentui
bash packages/core/scripts/build-native-termux.sh
```

The same build runs in GitHub Actions on every push to `main` and uploads the Android ARM64 native library as a workflow artifact.

Versions follow upstream exactly. Update `androidtui.json` only when adopting a new upstream release, refresh patches against that pinned commit, and then create the matching release tag:

```bash
git tag androidtui-v0.5.1
git push origin androidtui-v0.5.1
```

The `androidtui-v*` tag triggers the unified release workflow for all `@androidtui` packages.

## Upstream and License

ANDROIDTUI is maintained as an Android-focused patch set on top of [anomalyco/opentui](https://github.com/anomalyco/opentui). OpenTUI's architecture, APIs, and most source code are developed by the upstream OpenTUI contributors.

Released under the [MIT License](LICENSE).
