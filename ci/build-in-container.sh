#!/data/data/com.termux/files/usr/bin/bash

set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX

# pkg mirror rotation can select stale mirrors. Pin Termux's canonical source.
printf '%s\n' 'deb https://packages.termux.dev/apt/termux-main stable main' > "$PREFIX/etc/apt/sources.list"
apt update -y
apt install -y binutils clang curl file git libc++ ndk-sysroot nodejs-lts npm tar xz-utils zig

# Pinned OpenTUI requires Zig 0.17.x. Termux's stock `zig` package now ships
# 0.17.0, so install it from apt rather than a fragile 50 MB tarball. If a
# future apt moves ahead, fall back to the exact pin from ziglang.org.
ZIG_VERSION="0.17.0"
got="$(zig version 2>/dev/null || true)"
case "$got" in
  0.17.*) echo "✓ apt zig ${got}" ;;
  *)
    ZIG_FILE="zig-aarch64-linux-${ZIG_VERSION}.tar.xz"
    ZIG_URL="https://ziglang.org/download/${ZIG_VERSION}/${ZIG_FILE}"
    echo "apt zig '${got}' is not 0.17.x; installing Zig ${ZIG_VERSION} from ${ZIG_URL}"
    curl -fsSL --connect-timeout 20 --max-time 600 --retry 5 --retry-all-errors -o "$PREFIX/tmp/$ZIG_FILE" "$ZIG_URL"
    mkdir -p "$PREFIX/opt/zig"
    tar -xJf "$PREFIX/tmp/$ZIG_FILE" -C "$PREFIX/opt/zig" --strip-components=1
    rm -f "$PREFIX/tmp/$ZIG_FILE"
    ln -sf "$PREFIX/opt/zig/zig" "$PREFIX/bin/zig"
    ;;
esac

BUN_TERMUX_VERSION="1.4.4-patched"
curl -fsSL -o "$PREFIX/tmp/bun.deb" \
  "https://github.com/bd-loser/bun-termux/releases/download/v${BUN_TERMUX_VERSION}/bun_${BUN_TERMUX_VERSION}_aarch64.deb"
dpkg -i "$PREFIX/tmp/bun.deb"
rm -f "$PREFIX/tmp/bun.deb"
test "$(bun --version)" = "${BUN_TERMUX_VERSION%-patched}"

zig version

# Diagnostic: Zig 0.17 reshaped the libc paths-file schema. Print the exact
# field list this Zig expects so the overlay writes a parseable libc file.
echo "=== zig libc-file schema (LibCInstallation fields) ==="
ZIG_LIB_DIR="$(dirname "$(readlink -f "$(command -v zig)")")/lib"
for f in "$ZIG_LIB_DIR/std/zig/LibCInstallation.zig" "$PREFIX/lib/zig/lib/std/zig/LibCInstallation.zig" "$PREFIX/opt/zig/lib/std/zig/LibCInstallation.zig"; do
  [ -f "$f" ] || continue
  echo "--- $f"
  sed -n '1,80p' "$f" | grep -nE '^[a-z_]+:[[:space:]]*\?' || true
done
grep -rn "may not be empty\|missing field" "$ZIG_LIB_DIR/std/zig/LibCInstallation.zig" 2>/dev/null | head || true
echo "=== end schema ==="

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

# bun >= 1.4 inside termux-docker execs node_modules/.bin scripts through
# its posix_spawn shebang remap and drops the `node` argument, so
# bunx tsc dies during declaration generation. Replace the bin entries
# with a node-direct wrapper. Container-only repair; the published
# tarballs never see it.
echo "--- tsc diagnostics ---"
ls -la /usr/bin/env 2>&1 || true
ls -la packages/core/node_modules/.bin/ 2>&1 | grep -i tsc || echo "no tsc entry in packages/core/node_modules/.bin"
find . -maxdepth 5 -type d -name typescript -not -path './.git/*' 2>/dev/null | head -5
tsc_src="$(find "$PWD/node_modules" -path '*/typescript/bin/tsc' -type f -print -quit)"
echo "hoisted tsc: ${tsc_src:-NOT FOUND}"
test -n "$tsc_src"
# bun 1.4.x canary spawn drops the `node` argument when exec'ing
# scripts whose shebang is `#!/usr/bin/env node` via a symlinked bin
# dir, so env tries to exec the script itself (ENOENT, exit 127).
# Replace the bin entries with a wrapper that runs node directly.
for pkg in core react solid keymap qrcode three ssh; do
  bin_dir="packages/$pkg/node_modules/.bin"
  [ -d "packages/$pkg" ] || continue
  mkdir -p "$bin_dir"
  rm -f "$bin_dir/tsc"
  printf '#!%s/bin/bash\nexec "%s/bin/node" "%s" "$@"\n' "$PREFIX" "$PREFIX" "$tsc_src" > "$bin_dir/tsc"
  chmod +x "$bin_dir/tsc"
  echo "wrapped $bin_dir/tsc -> node $tsc_src"
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
    ot_buffer_create: { args: ["ptr", "ptr", "ptr"], returns: "u32" },
  });
  library.close();
  const { resolveRenderLib } = await import("@opentui/core");
  const renderLib = resolveRenderLib();
  const context = renderLib.createContext({ objectCapacity: 1024, renderCellsMax: 100000 });
  renderLib.destroyContext(context);
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
