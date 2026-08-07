# XINCLI patch kit — Android/Termux support for OpenTUI

This fork exists to run OpenTUI on Android under Termux. Everything it
adds lives in this directory, as a **patch kit** rather than a
long-lived fork branch.

The distinction matters. A fork branch accumulates: the 0.4.3-based
version of this work was ~40 commits, most of them diagnostics, and
every upstream release meant a hand-merge against all of it. A kit is
replayed fresh onto each upstream tag, so the only thing you ever merge
by hand is a hunk that genuinely conflicts.

## Porting to a new upstream release

```sh
bash scripts/xin-patch.sh 0.5.1
```

That creates branch `xin/0.5.1` from upstream tag `v0.5.1`, lays the kit
on top, and reports what conflicted. Then:

```sh
bun install
bash packages/core/scripts/build-native-termux.sh   # on-device, ~10 min
bash scripts/xin-regen.sh                           # move the kit's base forward
git add -A && git commit -m "port XINCLI Android patches to v0.5.1"
git tag xin-v0.5.1 && git push origin xin/0.5.1 xin-v0.5.1
```

The `xin-regen.sh` step is the one that is easy to skip and shouldn't
be. It rewrites the patches as diffs against the version you just
ported to, so the kit's base is always the last thing you shipped. Skip
it and the base stays at 0.5.0 forever, and the diffs get harder to
apply with every release — which is exactly the failure mode this whole
design exists to avoid.

## Layout

| Path | What it is |
| --- | --- |
| `meta.json` | The manifest: base tag, and the `add` / `mod` / `ignore` file lists. Editing the kit means editing this first. |
| `add/**` | Files upstream doesn't have. Copied verbatim. These never conflict, which is why as much logic as possible lives here rather than in `mod/`. |
| `mod/**.patch` | `git diff` against the base tag, applied with `git apply -3`. One patch per upstream file touched. |
| `apply-package-json.mjs` | The four `package.json` edits, done programmatically. |

## Why some things aren't patches

**`package.json`** — upstream reorders keys and bumps versions every
release, so a textual diff would conflict every single time. The script
makes the same edits structurally instead: strip `private` from react
and solid, add a `publish:xincli` alias. It's idempotent, and
`--check` reports drift.

**Workflow disabling** — upstream's CI assumes upstream's secrets and
runners; left active it fires on every push to the fork and fails
noisily. `xin-patch.sh` moves `.github/workflows/*` to
`.github/disabled-workflows/` mechanically, keeping anything named
`xin-*`. Mechanical means it works on any upstream version regardless of
which workflows exist that release.

**`packages/core/prebuilt/<arch>/libopentui.so`** — a binary, committed
on purpose. Cross-compiling aarch64-android from a GitHub x86 runner was
tried and abandoned; a native Termux build links against the exact
Bionic libc that will `dlopen` it. So the `.so` is built on the phone
and the release workflow just packages what's committed.

The `.so` does **not** carry across a port — `xin-patch.sh` branches
from a clean upstream tag, so it's simply absent, and you must rebuild.
That's deliberate: 0.5.1 added four FFI symbols
(`imageMaterialize`, `imageRetainIccCache`, `imageReleaseIccCache`,
`imageTestFailIccProfileCopyAllocationOnce`), and a 0.5.0 `.so` on 0.5.1
sources dies at load with `Symbol imageMaterialize not found`. Both the
build script and the release workflow diff the `.so`'s exported symbols
against the `dlopen()` table in `src/zig.ts` and refuse a stale one.

## What the patches actually do

| File | Change |
| --- | --- |
| `src/zig/build.zig` | Android/Bionic build support — 20 `XINCLI` markers. Android is `linux` + `.android` ABI in Zig, not a separate OS tag, so several upstream `.linux` branches need splitting. Paths come from `XINCLI_ANDROID_*` env vars set by the build script. |
| `src/node-asset-target.ts` | Adds an `android` platform resolving to `@xincli/opentui-core-android-<arch>`. Sits **before** the libc validation, because Bionic is neither glibc nor musl. Detects Termux via `$PREFIX`, since Bun reports `process.platform === "linux"` on Android while Node reports `"android"`. |
| `src/platform/runtime-assets.{bun,node}.ts` | Route Android through the new resolver. |
| `src/zig.ts` | Two lines: bunfs paths get extracted to a real file first, because `dlopen()` can't read Bun's virtual filesystem. |
| `scripts/build.ts` | Registers the `android`/`arm64` variant. |
| `.gitignore` | Ignores the ~22 MB of Zig vendoring scratch and the publish staging dirs. |

Additive modules (`platform/android-native.ts`,
`platform/bunfs-extract.ts`) hold the bulk of the runtime logic
precisely so the patches against upstream files stay small — `zig.ts`
went from `+79/−2` in the 0.4.3 fork to a 2-line change.

## Dropped patches

`src/zig/renderer-output.zig` carried a fix for a dangling-temporary
SIGSEGV. Upstream 0.5.0 restructured that code — `stdout` is a struct
field now and `writeBytes` uses `self.stdout.writerStreaming(...)` — so
the bug is gone and the patch with it.

## Releasing

One tag publishes all five packages at the same version:

```sh
git tag xin-v0.5.0 && git push origin xin-v0.5.0
```

`.github/workflows/xin-release.yml` then runs
`core-android-arm64` → `core` → `react`/`solid`/`keymap` (parallel),
and finishes by installing the published set from npm and importing it,
the way a consumer would.

The tree keeps upstream's `@opentui/*` names so `workspace:*` linking
works; `scripts/xin-repackage.mjs` does the rename to `@xincli/*` in
`dist/` at publish time, and rewrites every intra-fork dependency edge
to `npm:@xincli/...` so consumers never resolve upstream `@opentui/core`
— which throws `opentui is not supported` on Termux.

Versions track upstream exactly: upstream `0.5.0` publishes as
`@xincli/opentui-*@0.5.0`. npm versions are immutable, so a given base
gets one shot — `0.4.4` and `0.4.5` are already burned from an earlier
run. Both `xin-patch.sh` and the workflow check npm before doing
anything.
