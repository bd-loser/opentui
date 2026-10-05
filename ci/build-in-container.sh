#!/data/data/com.termux/files/usr/bin/bash

set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX

# pkg mirror rotation can select stale mirrors. Pin Termux's canonical source.
printf '%s\n' 'deb https://packages.termux.dev/apt/termux-main stable main' > "$PREFIX/etc/apt/sources.list"
apt update -y
apt install -y binutils clang curl file git libc++ ndk-sysroot nodejs-lts npm tar xz-utils zig

# Pin the bun build instead of floating on install.sh: 1.4.0-patched
# resolved the workspace differently inside termux-docker — typescript
# never landed under packages/core/node_modules, so declaration
# generation died with "node_modules/.bin/tsc: No such file or
# directory" (container-only break; fine on device). Now on 1.4.2-patched:
# Android 12 close_range seccomp fix plus upstream 1.4.2 install work.
# Non-publish CI runs are the gate before releases switch over.
curl -fsSL -o "$PREFIX/tmp/bun.deb" \
  "https://github.com/bd-loser/bun-termux/releases/download/v1.4.2-patched/bun_1.4.2-patched_aarch64.deb"
dpkg -i "$PREFIX/tmp/bun.deb"
rm -f "$PREFIX/tmp/bun.deb"

zig version

export ANDROIDTUI_WORK_ROOT="$HOME/androidtui-work"
rm -rf "$ANDROIDTUI_WORK_ROOT"
bun /workspace/scripts/prepare.mjs
bun /workspace/scripts/verify.mjs

ANDROIDTUI_VERSION="$(bun -e 'console.log(JSON.parse(require("node:fs").readFileSync("/workspace/androidtui.json", "utf8")).releaseVersion)')"
ANDROIDTUI_UPSTREAM_VERSION="$(bun -e 'console.log(JSON.parse(require("node:fs").readFileSync("/workspace/androidtui.json", "utf8")).upstream.tag.slice(1))')"
test -n "$ANDROIDTUI_VERSION"
test -n "$ANDROIDTUI_UPSTREAM_VERSION"
export ANDROIDTUI_VERSION
export ANDROIDTUI_UPSTREAM_VERSION

SOURCE_ROOT="$ANDROIDTUI_WORK_ROOT/opentui"
cd "$SOURCE_ROOT"
bash packages/core/scripts/build-native-termux.sh

SO="$SOURCE_ROOT/packages/core/prebuilt/aarch64-android/libopentui.so"
test -s "$SO"
file "$SO"
cp "$SO" /out/libopentui.so

echo "=== Installing workspace dependencies with bun-termux ==="
bun install --ignore-scripts

# bun >= 1.4 inside termux-docker leaves workspace .bin links dangling
# (packages/core/node_modules/.bin/tsc points at a hoisted-away copy),
# so bunx tsc dies during declaration generation. Re-point the bin at
# wherever typescript actually landed. Container-only repair; the
# published tarballs never see it.
echo "--- tsc diagnostics ---"
ls -la packages/core/node_modules/.bin/ 2>&1 | grep -i tsc || echo "no tsc entry in packages/core/node_modules/.bin"
find . -maxdepth 5 -type d -name typescript -not -path './.git/*' 2>/dev/null | head -5
tsc_src="$(find "$PWD/node_modules" -path '*/typescript/bin/tsc' -type f -print -quit)"
echo "hoisted tsc: ${tsc_src:-NOT FOUND}"
for pkg in core react solid keymap qrcode three ssh; do
  bin_dir="packages/$pkg/node_modules/.bin"
  [ -d "packages/$pkg" ] || continue
  if [ ! -e "$bin_dir/tsc" ]; then
    test -n "$tsc_src"
    mkdir -p "$bin_dir"
    ln -sf "$tsc_src" "$bin_dir/tsc"
    echo "linked $bin_dir/tsc -> $tsc_src"
  fi
done
( cd packages/core && bunx tsc --version )

echo "=== Packaging @androidtui/core-android-arm64 ==="
bun packages/core/scripts/package-prebuilt.ts
mkdir -p /out/packages
npm pack packages/core/dist-prebuilt/@androidtui/core-android-arm64 --pack-destination /out/packages

echo "=== Building ANDROIDTUI JavaScript packages ==="
for package_name in core react solid keymap qrcode three ssh; do
  bun scripts/androidtui-repackage.mjs --package "$package_name" --version "$ANDROIDTUI_VERSION"
done
cp artifacts/*.tgz /out/packages/

echo "=== Smoke-testing packaged Bionic native library ==="
SMOKE_ROOT="$HOME/androidtui-smoke"
rm -rf "$SMOKE_ROOT"
mkdir -p "$SMOKE_ROOT"
cat > "$SMOKE_ROOT/package.json" <<EOF
{
  "name": "androidtui-bionic-smoke",
  "private": true,
  "type": "module",
  "dependencies": {
    "@opentui/core": "file:/out/packages/androidtui-core-${ANDROIDTUI_VERSION}.tgz",
    "@opentui/core-android-arm64": "file:/out/packages/androidtui-core-android-arm64-${ANDROIDTUI_VERSION}.tgz"
  }
}
EOF
cd "$SMOKE_ROOT"
bun install --ignore-scripts
bun -e '
  const { dlopen } = await import("bun:ffi");
  const native = (await import("@opentui/core-android-arm64")).default;
  const library = dlopen(native, {
    createNativeRenderable: { args: [], returns: "u32" },
  });
  library.close();
  await import("@opentui/core");
  console.log(`Bionic package smoke test passed: ${native}`);
'

cd /out
sha256sum libopentui.so packages/*.tgz > SHA256SUMS

bun -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync("/workspace/androidtui.json", "utf8"));
  fs.writeFileSync("build-manifest.json", JSON.stringify({
    version: config.releaseVersion,
    upstreamVersion: config.upstream.tag.slice(1),
    upstream: config.upstream,
    platform: "android",
    architecture: "arm64",
    packages: config.packages
  }, null, 2) + "\n");
'
