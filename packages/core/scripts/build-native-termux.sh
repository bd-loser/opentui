#!/data/data/com.termux/files/usr/bin/bash
# ═════════════════════════════════════════════════════════════════
# XINCLI OpenTUI — Native Termux Build Script
#
# RUN THIS ON YOUR ANDROID PHONE (in Termux).
# It builds libopentui.so natively — no cross-compilation, no NDK,
# no sysroot headaches. The .so is linked against the exact Bionic
# libc that will load it, so it's guaranteed to work.
#
# Prerequisites (install in Termux):
#   pkg install nodejs git clang
#   # Zig doesn't have a Termux package — download the aarch64-linux build:
#   curl -L https://ziglang.org/download/0.15.2/zig-aarch64-linux-0.15.2.tar.xz | tar xJ
#   export PATH="$PWD/zig-aarch64-linux-0.15.2:$PATH"
#
# Usage:
#   git clone https://github.com/bd-loser/opentui.git
#   cd opentui
#   bash packages/core/scripts/build-native-termux.sh
#
# Output:
#   packages/core/prebuilt/aarch64-android/libopentui.so
#
# After the build succeeds:
#   1. Copy the .so to your laptop (scp, adb, git push — whatever)
#   2. Commit it to the repo
#   3. The package-prebuilt.yml workflow publishes it to npm
# ═════════════════════════════════════════════════════════════════

set -e

# ── Verify we're on Termux/Android ──────────────────────────────
if [ -z "$PREFIX" ] || [ ! -d "/data/data/com.termux" ]; then
  echo "⚠️  This script is meant to run on Termux (Android)."
  echo "   Detected PREFIX=$PREFIX"
  echo "   If you're on Linux/macOS, use the cross-compile workflow instead."
  echo "   Continuing anyway in 3s..." ; sleep 3
fi

# ── Verify Zig is installed ─────────────────────────────────────
if ! command -v zig >/dev/null 2>&1; then
  echo "❌ Zig not found in PATH."
  echo "   Install it in Termux:"
  echo "     curl -L https://ziglang.org/download/0.15.2/zig-aarch64-linux-0.15.2.tar.xz | tar xJ"
  echo "     export PATH=\"\$PWD/zig-aarch64-linux-0.15.2:\$PATH\""
  exit 1
fi

ZIG_VERSION=$(zig version 2>/dev/null || echo "unknown")
echo "✓ Zig $ZIG_VERSION detected"
if [ "$ZIG_VERSION" != "0.15.2" ]; then
  echo "⚠️  Expected Zig 0.15.2, got $ZIG_VERSION. Build may fail."
fi

# ── Verify we're in the repo root ───────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
if [ ! -f "$REPO_ROOT/packages/core/package.json" ]; then
  echo "❌ Could not find packages/core/package.json"
  echo "   Run this script from the repo root: bash packages/core/scripts/build-native-termux.sh"
  exit 1
fi

echo "✓ Repo root: $REPO_ROOT"

# ── Install bun (needed for yoga dependency fetch) ──────────────
if ! command -v bun >/dev/null 2>&1; then
  echo "📦 Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

cd "$REPO_ROOT"
echo "📦 Installing dependencies..."
bun install 2>&1 | tail -3

# ── Build the native .so ────────────────────────────────────────
# Native build: Zig detects the host (aarch64-linux) automatically.
# No -Dtarget, no --sysroot, no NDK. Bionic libc is already here.
#
# The only Android-specific tweak: OpenSLES (Android's audio backend)
# is linked via the .so file directly because Termux's library search
# path discovery is sometimes flaky.
cd "$REPO_ROOT/packages/core/src/zig"

echo ""
echo "🔧 Building libopentui.so natively (this takes 2-5 minutes)..."
echo "   Target: $(zig env | grep target | head -1)"

# Export XINCLI_ANDROID_LIB_PATH so build.zig's addObjectFile finds
# libOpenSLES.so in Termux's lib dir.
export XINCLI_ANDROID_LIB_PATH="${PREFIX}/lib"

zig build -Doptimize=ReleaseFast 2>&1 | tail -20

# ── Locate the produced .so ─────────────────────────────────────
SO_PATH=""
for candidate in \
  "$REPO_ROOT/packages/core/src/zig/zig-out/lib/libopentui.so" \
  "$REPO_ROOT/packages/core/src/zig/zig-out/lib/libopentui.so.$(zig version)" \
  "$(find "$REPO_ROOT/packages/core/src/zig/zig-out" -name 'libopentui*.so' 2>/dev/null | head -1)"; do
  if [ -f "$candidate" ]; then
    SO_PATH="$candidate"
    break
  fi
done

if [ -z "$SO_PATH" ]; then
  echo "❌ libopentui.so not found after build. Check zig-out/ contents:"
  find "$REPO_ROOT/packages/core/src/zig/zig-out" -type f 2>/dev/null | head -20
  exit 1
fi

echo "✓ Built: $SO_PATH"
echo "   Size: $(du -h "$SO_PATH" | cut -f1)"

# ── Verify it's a valid ARM64 ELF ───────────────────────────────
echo ""
echo "🔍 Verifying .so architecture..."
file "$SO_PATH" 2>/dev/null || echo "(file command not available — skipping verify)"

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
echo "║  Next steps:                                                 ║"
echo "║   1. git add packages/core/prebuilt/                         ║"
echo "║   2. git commit -m 'build: native arm64 .so from Termux'     ║"
echo "║   3. git push origin main                                    ║"
echo "║                                                              ║"
echo "║  The package-prebuilt.yml workflow will publish it to npm.   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
