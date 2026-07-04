# Native Termux Build — XINCLI OpenTUI Fork

This fork builds the opentui native core **natively on Termux** instead of
cross-compiling from x86-linux. Cross-compilation to Android (Bionic libc)
turned out to be genuinely hard — 11 CI iterations fighting sysroots, libc
files, and header paths. Native builds skip all of it.

## The flow

```
┌─────────────────────────────────────────────────────────┐
│  YOUR PHONE (Termux, aarch64)                           │
│                                                          │
│  build-native-termux.sh                                  │
│    ↓  zig build -Doptimize=ReleaseFast                   │
│    ↓  (no -Dtarget, no --sysroot, no NDK)                │
│  prebuilt/aarch64-android/libopentui.so                  │
│    ↓  git add + commit + push                            │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  GITHUB ACTIONS (ubuntu-22.04, free, no queue)          │
│                                                          │
│  package-prebuilt.yml                                    │
│    ↓  verify .so is ARM64 ELF                            │
│    ↓  package-prebuilt.ts → dist-prebuilt/@xincli/...    │
│    ↓  npm publish (if XINCLI_NPM_TOKEN set)              │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  NPM                                                     │
│                                                          │
│  @xincli/opentui-core-android-arm64                      │
│    ↓  npm install                                        │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  USER'S PHONE (Termux)                                   │
│                                                          │
│  XINCLI's cli.mjs                                        │
│    ↓  import('@opentui/core')                            │
│    ↓  resolveNativePackage() loads @xincli/...           │
│    ↓  libopentui.so loads — full opentui renderer 🎉     │
└─────────────────────────────────────────────────────────┘
```

## One-time setup on your phone

```bash
# In Termux:
pkg install nodejs git clang

# Install Zig (aarch64-linux build runs natively on Termux)
curl -L https://ziglang.org/download/0.15.2/zig-aarch64-linux-0.15.2.tar.xz | tar xJ
echo 'export PATH="$HOME/zig-aarch64-linux-0.15.2:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Verify
zig version  # should print 0.15.2
```

## Building the .so

```bash
# Clone the fork
git clone https://github.com/bd-loser/opentui.git
cd opentui

# Build natively (2-5 minutes)
bash packages/core/scripts/build-native-termux.sh

# Commit the .so
git add packages/core/prebuilt/
git commit -m "build: native arm64 .so from Termux"
git push origin main
```

Push triggers the `package-prebuilt.yml` workflow, which packages the `.so`
and (if `XINCLI_NPM_TOKEN` is set) publishes it to npm.

## Setting the npm token

For the workflow to publish, you need an npm access token with publish
rights to the `@xincli` scope:

1. Create an account at npmjs.com (if you don't have one)
2. Create an org named `xincli`
3. Create an access token: npmjs.com → Access Tokens → Generate New Token → Automation
4. Add it to the fork: `github.com/bd-loser/opentui/settings/secrets/actions`
   - Name: `XINCLI_NPM_TOKEN`
   - Value: your token

Without the token, the workflow still packages the `.so` and uploads it as
a GitHub artifact — you can download it manually and publish by hand.

## Why not cross-compile?

We tried. 11 times. The progression:

| Run | Error |
|-----|-------|
| #1 | Zig has no `.android` OS tag (it's linux + .android ABI) |
| #2 | `linkSystemLibrary("OpenSLES")` couldn't find the .so |
| #3 | `--sysroot` alone didn't resolve Bionic libc |
| #4 | `linker_sysroot` field doesn't exist (snake_case) |
| #5 | `linkerSysroot` field doesn't exist (camelCase) either |
| #6 | `--sysroot` doubled `addLibraryPath` paths |
| #7 | `linkSystemLibrary` searched zero paths |
| #8 | Back to `unable to provide libc` |
| #9 | `asm/types.h` not found (arch-specific headers) |
| #10 | `@cImport` ignores CFLAGS |
| #11 | `sys_include_dir` in libc file needed arch path |

Each fix revealed a new layer. Native builds skip every layer because the
host's Bionic libc, headers, and library paths are all already correct.

## Building for other arches (arm, x86_64)

Most phones are aarch64 (arm64). For the other variants:

- **armv7 (legacy 32-bit phones):** Run Termux on an old phone, same script.
- **x86_64 (emulators):** Run Termux in an Android emulator on your laptop.

The script auto-detects the host arch and writes to the correct
`prebuilt/<arch>/` directory. Commit each arch's `.so` separately or all
together — the packaging workflow handles whatever's present.
