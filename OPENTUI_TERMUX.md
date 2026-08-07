# OpenTUI on Termux — How It Works

> **Canonical location:** `github.com/bd-loser/opentui/OPENTUI_TERMUX.md`
>
> Deep-dive documentation for the XINCLI fork of OpenTUI running natively on
> Android/Termux via Node.js 26.3+ `--experimental-ffi`.
>
> This doc captures everything we learned across 70+ native build iterations,
> 5 npm publish workflow iterations, and a full Phase 0-3 UI migration POC.
> If we ever come back to this, this doc is the map.
>
> **Related docs in this repo:**
> - [`NATIVE_BUILD.md`](NATIVE_BUILD.md) — How to build `libopentui.so` natively on Termux
> - [`packages/core/README.md`](packages/core/README.md) — Package-level install + usage
>
> **Related docs in the XINCLI app repo:**
> - [`Clagit/README.md`](https://github.com/bd-loser/Clagit#readme) — XINCLI app install + opentui support overview

---

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Architecture: Three Repositories](#architecture-three-repositories)
3. [The Termux Rendering Magic](#the-termux-rendering-magic)
4. [Published npm Packages](#published-npm-packages)
5. [Critical Problems & Solutions](#critical-problems--solutions)
6. [Build Pipelines](#build-pipelines)
7. [Runtime Selection](#runtime-selection)
8. [Phase Migration Status](#phase-migration-status)
9. [Restart Guide — If We Pick This Back Up](#restart-guide--if-we-pick-this-back-up)

---

## The Big Picture

XINCLI is a Claude Code fork that runs on Termux/Android. Originally it used
[Ink](https://github.com/vadimdemedes/ink) (React for terminals) for its UI.
We wanted to migrate to [OpenTUI](https://opentui.com) — a native Zig-based
terminal UI core with TypeScript bindings — because opentui offers:

- Native render performance (Zig core, not interpreted JS)
- Built-in components: `<scrollbox>`, `<markdown>`, `<code>`, `<diff>`, `<ascii-font>`, `<input>`, `<select>`, `<tab-select>`, `<frame-buffer>`
- Tree-sitter syntax highlighting out of the box
- Yoga flexbox layout engine
- Color intent system (rgb / indexed / default) that respects user terminal palettes

The problem: **opentui doesn't officially support Android/Termux**. There are
no prebuilt `aarch64-android` binaries. We had to fork opentui, build the
native `.so` on a phone, and publish it under the `@xincli` npm scope.

### The journey in one paragraph

We forked opentui into `github.com/bd-loser/opentui`, patched `resolveNativePackage()`
to load `@xincli/opentui-core-android-arm64`, built `libopentui.so` natively
on Termux (70+ iterations fighting Zig cross-compilation), published the `.so`
plus the compiled JS library to npm as `@xincli/opentui-core@0.4.7` and
`@xincli/opentui-react@0.4.7`, then proved it renders end-to-end under
Node 26.3+ with `--experimental-ffi` on a real phone.

---

## Architecture: Three Repositories

```
┌─────────────────────────────────────────────────────────────────────────┐
│  github.com/bd-loser/Clagit          (the XINCLI app)                   │
│                                                                         │
│  source/src/                                                            │
│    ink.ts                  ← legacy Ink-based UI (Node 20+)             │
│    tui/                    ← new opentui-based UI (Node 26.3+)          │
│      tokens.ts               - Aurora Glass design tokens               │
│      main.tsx                - opentui entry point                      │
│      components/             - Glass, AuroraWordmark, PromptInput,      │
│                                MessageList, StatusBar, etc.             │
│    components/             ← existing Ink components (147 files)        │
│                                                                         │
│  source/scripts/                                                        │
│    build-termux.ts          ← builds dist/cli.mjs (Ink, 20 MB)          │
│    build-tui.ts             ← builds dist/cli-opentui.mjs (opentui)     │
│    build-tui-poc.ts         ← builds self-contained POC bundle          │
│    build-tui-poc-published.ts ← builds POC using published npm packages │
│                                                                         │
│  source/bin/xincli          ← dual-runtime launcher                    │
│    Node 26.3+ → cli-opentui.mjs (--experimental-ffi)                   │
│    Older Node → cli.mjs (Ink, legacy)                                  │
│                                                                         │
│  .github/workflows/                                                     │
│    build-termux.yml         ← builds Ink cli.mjs + publishes @xincli/cli│
│    publish-npm.yml          ← publishes @xincli/cli to npm              │
│                                                                         │
│  poc/                       ← Phase 0-3 POC bundles for phone testing  │
└─────────────────────────────────────────────────────────────────────────┘
                                ↓ depends on
┌─────────────────────────────────────────────────────────────────────────┐
│  github.com/bd-loser/opentui        (the opentui fork)                  │
│                                                                         │
│  packages/core/                                                        │
│    src/                     ← TypeScript source (patched)               │
│      zig.ts                   - resolveNativePackage() patched          │
│                                  to load @xincli/opentui-core-android-* │
│      platform/ffi.ts          - bun:ffi OR node:ffi backend detection   │
│      zig/build.zig            - Android target added                    │
│    scripts/                                                              │
│      build.ts                  - compiles TS→JS into dist/               │
│      package-prebuilt.ts       - packages .so into npm dirs              │
│      build-native-termux.sh    - builds .so natively on phone            │
│    prebuilt/aarch64-android/                                           │
│      libopentui.so             - the native binary (12 MB ARM64 ELF)    │
│                                                                         │
│  packages/react/                                                        │
│    src/                     ← React reconciler source                   │
│    scripts/build.ts           - compiles TS→JS into dist/                │
│                                                                         │
│  .github/workflows/                                                     │
│    package-prebuilt.yml       ← packages + publishes .so                │
│    publish-js-library.yml     ← builds + publishes JS library           │
└─────────────────────────────────────────────────────────────────────────┘
                                ↓ published to
┌─────────────────────────────────────────────────────────────────────────┐
│  npm registry                                                           │
│                                                                         │
│  @xincli/cli                         ← the XINCLI app package           │
│  @xincli/opentui-core                ← compiled opentui core JS         │
│  @xincli/opentui-react               ← compiled opentui react binding   │
│  @xincli/opentui-core-android-arm64  ← native .so for Android arm64     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## The Termux Rendering Magic

This is the part that took the longest to figure out. Here's exactly how
opentui renders to a Termux terminal on Android.

### Step 1: Node.js loads the bundle

```bash
node --experimental-ffi cli-opentui.mjs
```

The `--experimental-ffi` flag enables Node's `node:ffi` module (available
in Node 26.3.0+). Without it, `import('node:ffi')` throws.

### Step 2: The bundle imports `@xincli/opentui-core`

```js
import { createCliRenderer } from '@xincli/opentui-core'
```

The published `@xincli/opentui-core@0.4.7` has `main: index.js` — compiled
JS (not TS source). Node resolves this from `node_modules/`.

### Step 3: `createCliRenderer()` calls `resolveNativePackage()`

Inside `@xincli/opentui-core`, the `zig.ts` module runs:

```ts
async function resolveNativePackage() {
  if (process.platform === 'android') {
    if (process.arch === 'arm64') {
      return await import('@xincli/opentui-core-android-arm64')
    }
    // ...
  }
  // darwin/linux/win32 branches use upstream @opentui/core-* packages
}
```

**The patch:** Upstream opentui doesn't have an `android` branch. We added
it to load our `@xincli/opentui-core-android-arm64` package instead.

### Step 4: The native package exports the `.so` path

`@xincli/opentui-core-android-arm64@0.4.7` has this `index.js`:

```js
import { fileURLToPath } from 'node:url'
export default fileURLToPath(new URL('./libopentui.so', import.meta.url))
```

So `nativePackage.default` is a string path like
`/path/to/node_modules/@xincli/opentui-core-android-arm64/libopentui.so`.

**Critical:** The package's `package.json` must have `main: index.js`, NOT
`main: libopentui.so`. If you point `main` at the `.so` directly, Node tries
to ESM-import a binary file and throws `ERR_UNKNOWN_FILE_EXTENSION`.

### Step 5: opentui's FFI backend loads the `.so`

`@xincli/opentui-core`'s `platform/ffi.ts` detects the runtime:

```ts
const isBun = typeof process.versions.bun === 'string'

function loadBackend() {
  if (isBun) return createBunBackend(require('bun:ffi'))
  try {
    const nodeFfi = require('node:ffi')
    return createNodeBackend(nodeFfi.default ?? nodeFfi)
  } catch (error) {
    return createUnsupportedBackend(error)
  }
}
```

- **Bun:** uses `bun:ffi` (built-in, no flags)
- **Node 26.3+:** uses `node:ffi` (requires `--experimental-ffi`)
- **Older Node:** falls back to `createUnsupportedBackend()` → `createCliRenderer()` throws

Once the backend is loaded, opentui calls `dlopen(libopentui.so)` and
resolves the C ABI symbols (`createNativeRenderable`, `render`, etc.).

### Step 6: The native renderer takes over stdout

`createCliRenderer()` switches the terminal to the alternate screen,
enables mouse tracking, sets up the render loop at 30 FPS target, and
starts writing ANSI escape sequences directly to `process.stdout`.

The Zig core handles:
- Yoga layout calculation (flexbox)
- Cell-based double-buffering (only repaints changed cells)
- ANSI 256 / truecolor output
- Mouse + keyboard input parsing
- Frame scheduling

### Step 7: React mounts via `@xincli/opentui-react`

```tsx
import { createRoot } from '@xincli/opentui-react'
createRoot(renderer).render(<App />)
```

The React reconciler translates React state changes into opentui
renderable mutations. When you call `setState`, React reconciles,
calls `appendInitialChild` / `remove` / `setStyle` on the native
renderables, and opentui's next frame paints the result.

### Why this is "magic"

The `.so` is a 12 MB ARM64 ELF binary compiled against Android's Bionic
libc. It runs in the same Node.js process as your JavaScript. When you
write `<box backgroundColor="#818cf6">`, the string `'#818cf6'` crosses
the FFI boundary as a packed RGBA value, gets stored in opentui's
optimized cell buffer, and on the next frame the renderer emits
`\x1b[48;2;129;140;246m` to color that cell.

The whole stack — React → reconciler → opentui JS bindings → FFI →
Zig core → ANSI → terminal — runs at 30 FPS on a phone. That's the magic.

---

## Published npm Packages

### `@xincli/opentui-core@0.4.7`

**What it is:** Compiled JavaScript of the opentui core library (TypeScript
source transpiled to JS by the fork's `scripts/build.ts`).

**Size:** 1.18 MB (176 files including tree-sitter wasm assets)

**Key files:**
- `index.js` — main entry (bundled + code-split chunks)
- `index.d.ts` — TypeScript declarations
- `assets/*.wasm` — tree-sitter parser wasm files
- `package.json` — `main: index.js`, `type: module`

**Dependencies:**
- `bun-ffi-structs`, `diff`, `marked`, `string-width`, `strip-ansi`
- `web-tree-sitter` (peer)
- `@opentui/core-{darwin,linux,win32}-*` (optional, upstream native packages)
- `@xincli/opentui-core-android-{arm64,arm,x64}` (optional, our Android native packages)

**Install:**
```bash
npm install @xincli/opentui-core@0.4.7
```

### `@xincli/opentui-react@0.4.7`

**What it is:** Compiled JavaScript of the opentui React reconciler.

**Size:** 22 KB (58 files)

**Key files:**
- `index.js` — main entry
- `jsx-runtime.js` — JSX runtime (for `jsxImportSource`)
- `chunk-*.js` — code-split chunks

**Dependencies:**
- `@opentui/core: npm:@xincli/opentui-core@0.4.7` (aliased to our fork)
- `react-reconciler: ^0.33.0`

**Peer dependencies:**
- `react: >=19.2.0`
- `react-devtools-core: ^7.0.1`
- `ws: ^8.18.0`

**Install:**
```bash
npm install @xincli/opentui-react@0.4.7 react@19.2.0 react-reconciler@0.33.0 \
  react-devtools-core@7.0.1 ws@8.18.0 --legacy-peer-deps
```

> `--legacy-peer-deps` is required because `react-reconciler@0.33`'s peer dep
> range (`react: ^19.2.0`) can conflict with other packages in the dep tree.

### `@xincli/opentui-core-android-arm64@0.4.7`

**What it is:** The native `libopentui.so` binary plus an `index.js` wrapper
that exports the `.so` path.

**Size:** 11.8 MB (4 files)

**Key files:**
- `libopentui.so` — 12 MB ARM64 ELF, NDK r29, built natively on Termux
- `index.js` — `export default fileURLToPath(new URL('./libopentui.so', import.meta.url))`
- `index.d.ts` — `declare const path: string; export default path`
- `package.json` — `main: index.js` (NOT `libopentui.so`!)

**Why `index.js`?** opentui's `resolveNativePackage()` does:
```ts
const nativePackage = await import('@xincli/opentui-core-android-arm64')
let targetLibPath = nativePackage.default
// → dlopen(targetLibPath)
```
It expects `nativePackage.default` to be a path STRING, not the binary itself.
If `main` points at `libopentui.so`, Node tries to ESM-import the binary
and crashes with `ERR_UNKNOWN_FILE_EXTENSION`.

**Install:** Auto-installed as an optionalDependency of `@xincli/opentui-core`
on Android/arm64 devices.

### `@xincli/cli@2.2.1` (current stable)

**What it is:** The XINCLI app — Ink-based UI (legacy).

**Does NOT use opentui at runtime.** The `@opentui/core` and `@opentui/react`
deps are listed but the bundle never calls `createCliRenderer()`.

**Install:**
```bash
npm install -g @xincli/cli
xincli  # runs the Ink UI under Node 20+
```

---

## Critical Problems & Solutions

### Problem 1: `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".so"`

**Symptom:**
```
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".so" for
/.../node_modules/@xincli/opentui-core-android-arm64/libopentui.so
```

**Cause:** `@xincli/opentui-core-android-arm64@0.4.5` had `main: libopentui.so`.
Node tried to ESM-import the binary directly.

**Solution:** Published `@0.4.7` with an `index.js` wrapper:
```js
import { fileURLToPath } from 'node:url'
export default fileURLToPath(new URL('./libopentui.so', import.meta.url))
```
And set `main: index.js` in package.json. The wrapper exports the `.so` PATH
as a string, which is what opentui's `resolveNativePackage()` expects.

---

### Problem 2: `Stripping types is currently unsupported for files under node_modules`

**Symptom:**
```
Error: Stripping types is currently unsupported for files under node_modules,
for "file:///.../node_modules/@opentui/core/src/index.ts"
```

**Cause:** `@xincli/opentui-core@0.4.6` shipped raw TypeScript source
(`main: src/index.ts`). Bun can run TS natively, but Node cannot.

**Solution:** Published `@0.4.7` with compiled JS. The fork's
`scripts/build.ts` runs `bun build` + `tsc` to produce `dist/` with
`index.js` + `.d.ts`. The `package.json` `main` field now points to
`index.js` (compiled), not `src/index.ts` (source).

---

### Problem 3: `Cannot find module 'react-reconciler/constants'`

**Symptom:**
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/.../node_modules/react-reconciler/constants'
Did you mean to import "react-reconciler/constants.js"?
```

**Cause:** opentui-react's bundled chunks use Bun-style imports without
`.js` extensions:
```js
import { ConcurrentRoot } from 'react-reconciler/constants'
```
Bun resolves this fine. Node ESM requires explicit `.js`.

**Solution:** The `publish-js-library.yml` workflow patches all `.js` files
in the react package during repackaging:
```bash
sed -i -E 's|from "(react-reconciler)/([a-zA-Z0-9_/-]+)"|from "\1/\2.js"|g' "$f"
```
This adds `.js` to bare subpath imports, making them Node ESM-compatible.

---

### Problem 4: `Cannot find package '@opentui/react'`

**Symptom:**
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@opentui/react'
imported from /.../tui-welcome-published.mjs
```

**Cause:** The bundle imported `@opentui/react`, but `node_modules/` only
had `@xincli/opentui-react`. npm's alias (`@opentui/core: npm:@xincli/opentui-core`)
only creates the `@opentui/core` symlink, not `@opentui/react`.

**Solution:** Changed all imports in the POC and main app to use
`@xincli/opentui-react` directly:
```ts
// Before (broken):
import { createRoot } from '@opentui/react'

// After (working):
import { createRoot } from '@xincli/opentui-react'
```
Also updated `jsxImportSource` in esbuild config to `@xincli/opentui-react`.

---

### Problem 5: `node:ffi` not available

**Symptom:**
```
Error: Cannot find module 'node:ffi'
```

**Cause:** Node.js < 26.3 doesn't have the `node:ffi` module. It's
experimental and only available in 26.3.0+.

**Solution:** Require Node 26.3+ and run with `--experimental-ffi`:
```bash
pkg upgrade nodejs  # on Termux, gets 26.x
node --experimental-ffi cli-opentui.mjs
```

The `bin/xincli` launcher auto-detects Node version:
- Node 26.3+ → runs `cli-opentui.mjs` with `--experimental-ffi`
- Older Node → falls back to `cli.mjs` (Ink, no FFI needed)
- `XINCLI_LEGACY=1` env var → forces legacy Ink UI

---

### Problem 6: opentui doesn't support Android

**Symptom:** Upstream opentui has no `android` branch in `resolveNativePackage()`.
On Termux, `process.platform === 'android'`, so it throws
`opentui is not supported on the current platform: android-arm64`.

**Solution:** Forked opentui and patched `src/zig.ts`:
```ts
if (process.platform === 'android') {
  if (process.arch === 'arm64') {
    return await import('@xincli/opentui-core-android-arm64')
  }
  if (process.arch === 'arm') {
    return await import('@xincli/opentui-core-android-arm')
  }
  if (process.arch === 'x64') {
    return await import('@xincli/opentui-core-android-x64')
  }
}
```

Also patched `src/zig/build.zig` to add the `aarch64-linux-android` target.

---

### Problem 7: Cross-compilation to Android is hell

**Symptom:** 11 CI iterations trying to cross-compile from x86-linux to
aarch64-android, each failing with a different error (sysroot, libc,
headers, NDK paths, etc.).

**Solution:** **Build natively on Termux.** Run the build script on an
actual Android phone. The host's Bionic libc, headers, and library paths
are all already correct. No cross-compilation needed.

See `NATIVE_BUILD.md` in the opentui fork for the full flow.

---

### Problem 8: TLS crashes on first HTTPS request

**Symptom:** opentui renderer starts, but as soon as XINCLI makes an API
call, the process crashes with a TLS-related segfault.

**Cause:** The `.so` was linked against Termux's Bionic libc, but at
runtime the dynamic linker was loading `/apex/com.android.runtime/lib64/bionic/libc.so`
instead. The two libcs have different TLS layouts, and the mismatch
corrupts thread-local storage.

**Solution:** Set the `.so`'s `RUNPATH` to prefer Termux's lib dir:
```
RUNPATH: $PREFIX/lib:/system/lib64
```
This makes the linker load Termux's Bionic first (matching what the `.so`
was built against), then fall back to system libs for anything missing.

Also: after building, delete any Bionic `.so` copies from `$PREFIX/lib`
to prevent the linker from picking them up and causing the same TLS crash
in reverse.

---

### Problem 9: `__ndk1` namespace conflicts

**Symptom:** Linking succeeds but at runtime symbols like
`std::__ndk1::string` are missing.

**Cause:** Zig's `linkLibC++()` links against Zig's bundled libc++ which
uses the `__ndk1` ABI namespace. Termux's libc++_shared.so uses `__ndk1`
too, but the two don't mix.

**Solution:** Set `link_libcpp=false` in `build.zig` (don't link Zig's
libc++) and rely on Termux's `libc++_shared.so` at runtime. Set `RUNPATH`
to include `$PREFIX/lib` so the linker finds it.

---

### Problem 10: ARM atomic builtins missing

**Symptom:** Link errors about `__atomic_fetch_add_8` and similar.

**Cause:** ARM64 needs `libcompiler_rt` for atomic operations. Zig usually
bundles this, but with `link_libc=true` against Bionic, the bundled
`compiler_rt` wasn't being linked.

**Solution:** Keep `bundle_compiler_rt = true` (don't set it to false).
Zig bundles a compiler_rt that works with Bionic.

---

### Problem 11: Messages getting clipped in scrollbox

**Symptom:** "After typing so many msgs i see msg cuts also only can see
2 and half msg below its blank"

**Cause:** opentui's `<scrollbox>` requires an **explicit `height`** to
scroll. I was passing `flexGrow: 1` but the parent didn't have bounded
height, so scrollbox overflowed and clipped content.

**Solution:** Calculate message list height explicitly:
```ts
const messageListHeight = height - HEADER_ROWS - INPUT_ROWS - STATUSBAR_ROWS
```
Pass as `height={messageListHeight}` to `<MessageList>`.

Also: use correct opentui scrollbox props:
- `stickyScroll={true}` (not `autoScroll`)
- `stickyStart="bottom"` (auto-scroll to new messages)
- `viewportCulling={true}` (only render visible messages)

---

### Problem 12: Keyboard 'q' accidentally quitting

**Symptom:** "keyboard on everything broke" — typing `q` anywhere quit the app.

**Cause:** Global `useKeyboard` handler was checking for the `q` key:
```ts
if (key.name === 'q') { renderer.destroy() }
```
This fired on every `q` keystroke, even when typing in the input field.

**Solution:** Global keyboard handler ONLY checks for `escape` and `ctrl+c`:
```ts
useKeyboard((key) => {
  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
    // exit
  }
})
```
The `<input>` component handles its own keyboard input when focused.

---

### Problem 13: Text truncation on narrow terminals

**Symptom:** "Sonnet 4.6 · An" (status bar clipped), "⟫ pr" (tagline clipped)

**Cause:** Fixed-width panels (`width={70}`) overflowed on 40-50 col
Termux portrait mode. opentui's default `overflow: 'hidden'` clipped content.

**Solution:**
- All panels use `width="auto"` (fills parent minus padding)
- `overflow: 'visible'` (don't clip)
- StatusBar has 4 responsive tiers (≥70/50/30/<30 cols), sections drop off gracefully
- AuroraWordmark has 4 layout modes (full+wing / full / monogram / text-only)
- Status pills row uses `flexWrap="wrap"` so pills drop to next line

---

### Problem 14: Exit race condition

**Symptom:** On ESC/Q exit, error: `remove expects a renderable child object`

**Cause:** Calling `renderer.destroy()` synchronously inside the keyboard
handler races with React's reconciler. The reconciler has pending mutations
to commit (`clearContainer` iterates children and calls `.remove()`), but
the renderer is already torn down.

**Solution:** Defer destroy to next tick:
```ts
setExiting(true)
setTimeout(() => {
  try { renderer.destroy() } catch {}
  process.exit(0)
}, 50)
```

---

## Build Pipelines

### Pipeline 1: Native `.so` build (on phone)

```
Phone (Termux)
  ↓  zig build -Doptimize=ReleaseFast (no -Dtarget, no --sysroot, no NDK)
prebuilt/aarch64-android/libopentui.so
  ↓  git add + commit + push
GitHub
  ↓  package-prebuilt.yml workflow triggers
  ↓  verify .so is ARM64 ELF
  ↓  package-prebuilt.ts → dist-prebuilt/@xincli/...
  ↓  npm publish (if XINCLI_NPM_SECRET set)
npm: @xincli/opentui-core-android-arm64@<version>
```

### Pipeline 2: JS library build (on GitHub Actions)

```
GitHub Actions (ubuntu-22.04)
  ↓  checkout fork
  ↓  bun install (workspace deps)
  ↓  bun scripts/build.ts --lib  (core: TS → dist/index.js)
  ↓  bun scripts/build.ts        (react: TS → dist/index.js)
  ↓  repackage as @xincli/opentui-core (rename, bump version, fix deps)
  ↓  repackage as @xincli/opentui-react (rename, alias @opentui/core, patch .js extensions)
  ↓  verify both packages import under Node 26.3
  ↓  npm publish both
npm: @xincli/opentui-core@<version>
npm: @xincli/opentui-react@<version>
```

Trigger: `workflow_dispatch` with version input, or push tag `lib-v*`.

### Pipeline 3: XINCLI app build (on GitHub Actions)

```
GitHub Actions (ubuntu-22.04)
  ↓  checkout Clagit
  ↓  bun install --ignore-scripts
  ↓  bun scripts/build-termux.ts --no-sourcemap  (Ink: → dist/cli.mjs, 20 MB)
  ↓  bun scripts/build-tui.ts                    (opentui: → dist/cli-opentui.mjs, 20 KB)
  ↓  verify bin/xincli symlink resolution
  ↓  npm publish (if XINCLI_NPM_SECRET set)
npm: @xincli/cli@<version>
```

Both bundles ship in the npm package. `bin/xincli` picks the right one at
runtime based on Node version.

---

## Runtime Selection

`bin/xincli` auto-detects the runtime:

```sh
NODE_MAJOR=26
NODE_MINOR=3

if [ "${XINCLI_LEGACY:-0}" = "1" ]; then
  USE_OPENTUI=0
elif [ "${XINCLI_OPENTUI:-0}" = "1" ]; then
  USE_OPENTUI=1
elif [ "$NODE_MAJOR" -gt 26 ] || { [ "$NODE_MAJOR" -eq 26 ] && [ "$NODE_MINOR" -ge 3 ]; }; then
  if [ -f "$SCRIPT_DIR/../cli-opentui.mjs" ]; then
    USE_OPENTUI=1
  fi
fi

if [ "$USE_OPENTUI" -eq 1 ]; then
  exec node --experimental-ffi "$SCRIPT_DIR/../cli-opentui.mjs" "$@"
else
  exec node "$SCRIPT_DIR/../cli.mjs" "$@"
fi
```

| Environment | Node version | Runs | UI |
|---|---|---|---|
| Default | ≥ 26.3 | `cli-opentui.mjs --experimental-ffi` | opentui (new) |
| Default | < 26.3 | `cli.mjs` | Ink (legacy) |
| `XINCLI_LEGACY=1` | any | `cli.mjs` | Ink (legacy) |
| `XINCLI_OPENTUI=1` | any | `cli-opentui.mjs --experimental-ffi` | opentui (will fail if Node < 26.3) |

---

## Phase Migration Status

The full migration plan has 12 phases (0-11). Current status:

| Phase | Goal | Status |
|---|---|---|
| 0 | POC — prove opentui renders on Termux | ✅ Complete |
| 1 | Bootstrap dual-runtime architecture | ✅ Complete |
| 2 | WelcomeV2 on opentui | ✅ Complete |
| 3 | PromptInput + MessageList | ✅ Complete (paused) |
| 4 | Messages + Markdown | ⏸ Paused |
| 5 | Tool results | ⏸ Paused |
| 6 | Dialogs + Pickers | ⏸ Paused |
| 7 | HelpV2 + Commands | ⏸ Paused |
| 8 | Onboarding flow | ⏸ Paused |
| 9 | Mobile/Termux adaptation | ⏸ Paused |
| 10 | Motion system | ⏸ Paused |
| 11 | Drop Ink, ship @xincli/cli@3.0.0 | ⏸ Paused |

**Why paused:** User feedback was "I don't see freshness" — the opentui UI
didn't feel like a meaningful upgrade over the existing Ink UI. Migration
is paused indefinitely. The existing Ink-based `@xincli/cli@2.2.1` remains
the stable release.

The opentui infrastructure (fork, npm packages, build pipelines) is fully
working and ready if we decide to resume.

---

## Restart Guide — If We Pick This Back Up

If we resume the migration, here's the fastest path to get back to a working
state:

### 1. Verify the published packages still work

```bash
mkdir tui-test && cd tui-test
npm init -y
npm install \
  @xincli/opentui-core@0.4.7 \
  @xincli/opentui-react@0.4.7 \
  @xincli/opentui-core-android-arm64@0.4.7 \
  react@19.2.0 react-reconciler@0.33.0 \
  react-devtools-core@7.0.1 ws@8.18.0 \
  --legacy-peer-deps

# Copy the Phase 3 POC bundle
cp ~/clagit/claude-termux-release/poc/cli-opentui.mjs .

# Run it
node --experimental-ffi cli-opentui.mjs
```

If the aurora XINCLI logo renders, everything still works. Skip to step 3.

### 2. If packages are broken, rebuild them

The opentui fork is at `github.com/bd-loser/opentui`. To republish:

```bash
# Clone the fork
git clone https://github.com/bd-loser/opentui.git
cd opentui
bun install

# Trigger the JS library publish workflow (via GitHub UI or API)
# Actions → "Publish JS Library" → Run workflow → version: 0.4.8

# Or trigger the native .so publish workflow
# Actions → "Package Prebuilt Native" → Run workflow → publish: true
```

### 3. Pick up from Phase 4

The Phase 3 code is at `source/src/tui/` in the Clagit repo. To resume:

```bash
git clone https://github.com/bd-loser/Clagit.git
cd Clagit/source
bun install --ignore-scripts

# Build the opentui UI
bun scripts/build-tui.ts

# Test locally (needs Node 26.3+)
node --experimental-ffi dist/cli-opentui.mjs
```

Phase 4 goals:
- Replace the simulated assistant response with real API calls
- Use opentui's `<markdown>` component for assistant messages
- Use opentui's `<code>` component with tree-sitter highlighting
- Use opentui's `<diff>` component for file edit results

### 4. Key files to know

| File | Purpose |
|---|---|
| `source/src/tui/tokens.ts` | Aurora Glass design tokens (all colors, spacing, motion) |
| `source/src/tui/main.tsx` | opentui entry point (createCliRenderer + React root) |
| `source/src/tui/components/Glass.tsx` | GlassPanel/Card/Overlay/Dialog/Input + Pill/Divider/Backdrop |
| `source/src/tui/components/AuroraWordmark.tsx` | Animated block logo with aurora gradient |
| `source/src/tui/components/PromptInput.tsx` | opentui `<input>` with aurora focus ring |
| `source/src/tui/components/MessageList.tsx` | Scrollable conversation history |
| `source/src/tui/components/StatusBar.tsx` | Bottom strip (model · context · cost · fps) |
| `source/scripts/build-tui.ts` | esbuild config for `dist/cli-opentui.mjs` |
| `source/bin/xincli` | Dual-runtime launcher |

### 5. Key gotchas to remember

1. **Node 26.3+ required** for `node:ffi`. Lower versions can't run opentui.
2. **`--experimental-ffi` flag required** when running.
3. **`@xincli/opentui-core-android-arm64` needs `index.js`** wrapper, not `main: libopentui.so`.
4. **`<scrollbox>` needs explicit height** — flexGrow alone doesn't work.
5. **`<text>` only accepts string or `t\`...\``** — no nested `<text>` elements.
6. **`react-reconciler/constants` needs `.js`** extension for Node ESM.
7. **Global `useKeyboard` should only check ESC/Ctrl+C** — don't intercept typing.
8. **`renderer.destroy()` must be deferred** to avoid exit race condition.
9. **All panels use `width="auto"`** — fixed widths overflow on narrow terminals.
10. **The `.so` is built natively on Termux** — don't try to cross-compile.
