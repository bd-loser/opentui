#!/data/data/com.termux/files/usr/bin/bash
# ═════════════════════════════════════════════════════════════════
# XINCLI OpenTUI — Native Termux Build Script
#
# RUN THIS ON YOUR ANDROID PHONE (in Termux).
# Builds libopentui.so natively — no cross-compilation, no NDK.
#
# Prerequisites:
#   pkg install nodejs git clang
#   curl -L https://ziglang.org/download/0.15.2/zig-aarch64-linux-0.15.2.tar.xz | tar xJ
#   export PATH="$HOME/zig-aarch64-linux-0.15.2:$PATH"
#
# Usage:
#   git clone https://github.com/bd-loser/opentui.git
#   cd opentui
#   bash packages/core/scripts/vendor-deps.sh        # one-time, needs network
#   bash packages/core/scripts/build-native-termux.sh # builds offline after vendor
#
# Output: packages/core/prebuilt/aarch64-android/libopentui.so
# ═════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# ── Verify Zig ──────────────────────────────────────────────────
if ! command -v zig >/dev/null 2>&1; then
  echo "❌ Zig not found in PATH."
  echo "   curl -L https://ziglang.org/download/0.15.2/zig-aarch64-linux-0.15.2.tar.xz | tar xJ"
  echo "   export PATH=\"\$HOME/zig-aarch64-linux-0.15.2:\$PATH\""
  exit 1
fi
ZIG_VERSION=$(zig version 2>/dev/null || echo "unknown")
echo "✓ Zig $ZIG_VERSION detected"

# ── Verify vendored deps exist ──────────────────────────────────
DEPS_DIR="$REPO_ROOT/.zig-deps"
if [ ! -d "$DEPS_DIR/yoga" ] || [ ! -d "$DEPS_DIR/uucode" ]; then
  echo "📦 Vendored deps not found. Running vendor-deps.sh first..."
  bash "$SCRIPT_DIR/vendor-deps.sh"
fi

# ── Populate Zig's dep cache from vendored deps ─────────────────
# Zig's build.zig.zon fetches yoga + uucode from GitHub at build time,
# which fails on flaky mobile DNS. We pre-fetch them (vendor-deps.sh)
# and symlink into Zig's global cache so `zig build` finds them locally
# without any network access.
ZIG_GLOBAL_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/zig"
mkdir -p "$ZIG_GLOBAL_CACHE"

# The cache key is the hash from build.zig.zon. We use a fixed name per
# dep — Zig will look for <hash> as the cache key. If it's not there,
# Zig tries to fetch. We create the dirs with the expected hashes.
UUCODE_HASH="uucode-0.1.0-ZZjBPtA_TQCWp5PIKmfm5tu1WOkKWFmBGFEMxircPfkA"
YOGA_HASH="N-V-__8AAOYl0gAU76B1VRPFD9AWvy2VkOef2jN0B3sISTeO"

# Zig 0.15 cache layout: $XDG_CACHE_HOME/zig/p/<hash>/
mkdir -p "$ZIG_GLOBAL_CACHE/p"
if [ -d "$DEPS_DIR/uucode" ] && [ ! -d "$ZIG_GLOBAL_CACHE/p/$UUCODE_HASH" ]; then
  cp -r "$DEPS_DIR/uucode" "$ZIG_GLOBAL_CACHE/p/$UUCODE_HASH" 2>/dev/null || true
  echo "✓ Cached uucode in Zig global cache"
fi
if [ -d "$DEPS_DIR/yoga" ] && [ ! -d "$ZIG_GLOBAL_CACHE/p/$YOGA_HASH" ]; then
  cp -r "$DEPS_DIR/yoga" "$ZIG_GLOBAL_CACHE/p/$YOGA_HASH" 2>/dev/null || true
  echo "✓ Cached yoga in Zig global cache"
fi

# ── Verify we're on Termux (for Bionic detection) ───────────────
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
TERMUX_INCLUDE="$PREFIX/include"
TERMUX_LIB="$PREFIX/lib"

if [ ! -d "$TERMUX_INCLUDE" ]; then
  echo "⚠️  Termux include dir not found at $TERMUX_INCLUDE"
  echo "   This script is meant for Termux. Proceeding anyway..."
fi

# ── Generate a Zig libc file pointing at Termux's Bionic ────────
# CRITICAL: Without this, Zig detects the host as 'aarch64-linux-musl'
# (wrong!) and produces a .so that won't load on Termux. The libc file
# explicitly tells Zig where Termux's Bionic headers + libs live.
LIBC_FILE="$REPO_ROOT/packages/core/src/zig/libc-termux.txt"
cat > "$LIBC_FILE" << EOF
include_dir=$TERMUX_INCLUDE
sys_include_dir=$TERMUX_INCLUDE
crt_dir=$TERMUX_LIB
msvc_lib_dir=
kernel32_lib_dir=
gcc_dir=
EOF
echo "✓ Generated libc file: $LIBC_FILE"
echo "  → include_dir=$TERMUX_INCLUDE"
echo "  → crt_dir=$TERMUX_LIB"

# ── Build ───────────────────────────────────────────────────────
cd "$REPO_ROOT/packages/core/src/zig"

echo ""
echo "🔧 Building libopentui.so natively..."
echo "   Target: aarch64-linux-android (explicit — avoids musl misdetection)"
echo "   Sysroot: $PREFIX (Termux's Bionic)"
echo ""

# Explicit -Dtarget=aarch64-linux-android so Zig doesn't misdetect as musl.
# --sysroot points at Termux's PREFIX so Zig finds Bionic headers + libs.
# ZIG_LIBC env var makes Zig read our generated libc file.
export ZIG_LIBC="$LIBC_FILE"
export XINCLI_ANDROID_LIB_PATH="$TERMUX_LIB"

zig build \
  -Dtarget=aarch64-linux-android \
  -Doptimize=ReleaseFast \
  --sysroot "$PREFIX" \
  2>&1 | tail -30

# ── Locate the produced .so ─────────────────────────────────────
SO_PATH=""
for candidate in \
  "$REPO_ROOT/packages/core/src/zig/zig-out/lib/libopentui.so" \
  "$(find "$REPO_ROOT/packages/core/src/zig/zig-out" -name 'libopentui*.so' 2>/dev/null | head -1)"; do
  if [ -f "$candidate" ]; then
    SO_PATH="$candidate"
    break
  fi
done

if [ -z "$SO_PATH" ]; then
  echo ""
  echo "❌ libopentui.so not found after build."
  echo "   zig-out/ contents:"
  find "$REPO_ROOT/packages/core/src/zig/zig-out" -type f 2>/dev/null | head -20
  echo ""
  echo "   Common fixes:"
  echo "   - If yoga/uucode fetch failed: bash packages/core/scripts/vendor-deps.sh"
  echo "   - If DNS failed: try again on WiFi, or vendor deps on a laptop and push"
  exit 1
fi

echo ""
echo "✓ Built: $SO_PATH"
echo "  Size: $(du -h "$SO_PATH" | cut -f1)"

# ── Verify it's ARM64 + links Bionic ────────────────────────────
echo ""
echo "🔍 Verifying .so..."
if command -v file >/dev/null 2>&1; then
  file "$SO_PATH"
fi
if command -v readelf >/dev/null 2>&1; then
  echo "  ELF header:"
  readelf -h "$SO_PATH" 2>/dev/null | grep -E "Machine|Class" || true
  echo "  Dynamic deps (should include libc.so):"
  readelf -d "$SO_PATH" 2>/dev/null | grep NEEDED | head -10
fi

# ── Copy to prebuilt/ ───────────────────────────────────────────
OUT_DIR="$REPO_ROOT/packages/core/prebuilt/aarch64-android"
mkdir -p "$OUT_DIR"
cp "$SO_PATH" "$OUT_DIR/libopentui.so"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ✅ NATIVE BUILD COMPLETE                                    ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Output: packages/core/prebuilt/aarch64-android/libopentui.so ║"
echo "║                                                              ║"
echo "║  Next:                                                       ║"
echo "║   git add packages/core/prebuilt/                            ║"
echo "║   git commit -m 'build: native arm64 .so from Termux'        ║"
echo "║   git push origin main                                       ║"
echo "║                                                              ║"
echo "║  The package-prebuilt.yml workflow will publish to npm.      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
