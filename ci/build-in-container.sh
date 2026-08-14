#!/data/data/com.termux/files/usr/bin/bash

set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX

# pkg mirror rotation can select stale mirrors. Pin Termux's canonical source.
printf '%s\n' 'deb https://packages.termux.dev/apt/termux-main stable main' > "$PREFIX/etc/apt/sources.list"
apt update -y
apt install -y binutils clang curl file git libc++ ndk-sysroot nodejs-lts npm tar xz-utils zig

curl -fsSL https://raw.githubusercontent.com/bd-loser/bun-termux/main/scripts/install.sh | bash
export PATH="$HOME/.bun/bin:$PATH"

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
