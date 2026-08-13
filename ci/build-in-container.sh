#!/data/data/com.termux/files/usr/bin/bash

set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX

# pkg mirror rotation can select stale mirrors. Pin Termux's canonical source.
printf '%s\n' 'deb https://packages.termux.dev/apt/termux-main stable main' > "$PREFIX/etc/apt/sources.list"
apt update -y
apt install -y binutils clang curl file git libc++ ndk-sysroot tar xz-utils zig

curl -fsSL https://raw.githubusercontent.com/bd-loser/bun-termux/main/scripts/install.sh | bash
export PATH="$HOME/.bun/bin:$PATH"

# termux-docker supplies a Bionic userspace without Android's getprop binary.
# Zig queries it to resolve the Android API level for an explicit android target.
cat > "$PREFIX/bin/getprop" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
case "${1:-}" in
  ro.build.version.sdk) printf '%s\n' '35' ;;
  ro.product.cpu.abi) printf '%s\n' 'arm64-v8a' ;;
  *) printf '%s\n' '' ;;
esac
EOF
chmod 0755 "$PREFIX/bin/getprop"

export ANDROIDTUI_WORK_ROOT="$HOME/androidtui-work"
rm -rf "$ANDROIDTUI_WORK_ROOT"
bun /workspace/scripts/prepare.mjs
bun /workspace/scripts/verify.mjs

SOURCE_ROOT="$ANDROIDTUI_WORK_ROOT/opentui"
cd "$SOURCE_ROOT"
bash packages/core/scripts/build-native-termux.sh

SO="$SOURCE_ROOT/packages/core/prebuilt/aarch64-android/libopentui.so"
test -s "$SO"
file "$SO"
cp "$SO" /out/libopentui.so
cd /out
sha256sum libopentui.so > SHA256SUMS

bun -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync("/workspace/androidtui.json", "utf8"));
  fs.writeFileSync("build-manifest.json", JSON.stringify({
    version: config.upstream.tag.slice(1),
    upstream: config.upstream,
    platform: "android",
    architecture: "arm64"
  }, null, 2) + "\n");
'
