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

# ── Verify arch-specific asm headers exist ──────────────────────
# opentui's audio.zig does @cImport of <signal.h> → <asm/sigcontext.h>.
# Termux's base linux-headers doesn't include arch-specific asm headers;
# they come from the `ndk-sysroot` package. Without it, the build fails
# with 'asm/sigcontext.h' file not found.
ASM_DIR="$TERMUX_INCLUDE/aarch64-linux-android/asm"
if [ ! -d "$ASM_DIR" ]; then
  echo "📦 Arch-specific asm headers missing. Installing ndk-sysroot..."
  # ndk-sysroot provides aarch64-linux-android/asm/ + arch-specific headers
  pkg install -y ndk-sysroot 2>&1 | tail -5 || {
    echo "⚠️  pkg install ndk-sysroot failed. Try manually:"
    echo "   pkg install ndk-sysroot"
    echo "   Then re-run this script."
  }
fi

# Re-check after install attempt
if [ ! -d "$ASM_DIR" ]; then
  echo "❌ Arch-specific asm headers still missing at $ASM_DIR"
  echo "   Run: pkg install ndk-sysroot"
  echo "   Then re-run this script."
  exit 1
fi
echo "✓ asm headers found at $ASM_DIR"

# ── Find crt objects (crtbegin_so.o, crtend_so.o) ───────────────
# These are compile-time artifacts needed by ld.lld to produce a valid
# .so. On Termux they come from the ndk-sysroot or clang package. Without
# them, Zig falls back to glibc defaults and emits -lm -lc -ldl that fail.
CRT_DIR=""
for search_dir in \
  "$PREFIX/lib" \
  "$PREFIX/lib/aarch64-linux-android" \
  "$PREFIX/lib64/clang"/*/lib/linux \
  "$PREFIX/lib/clang"/*/lib/linux; do
  if ls $search_dir/crtbegin_so.o >/dev/null 2>&1; then
    CRT_DIR=$(dirname $(ls $search_dir/crtbegin_so.o 2>/dev/null | head -1))
    break
  fi
done

if [ -z "$CRT_DIR" ]; then
  echo "📦 crt objects not found — installing ndk-sysroot + clang..."
  pkg install -y ndk-sysroot clang 2>&1 | tail -5 || true
  for search_dir in \
    "$PREFIX/lib" \
    "$PREFIX/lib/aarch64-linux-android" \
    "$PREFIX/lib64/clang"/*/lib/linux \
    "$PREFIX/lib/clang"/*/lib/linux; do
    if ls $search_dir/crtbegin_so.o >/dev/null 2>&1; then
      CRT_DIR=$(dirname $(ls $search_dir/crtbegin_so.o 2>/dev/null | head -1))
      break
    fi
  done
fi

if [ -z "$CRT_DIR" ]; then
  echo "❌ Cannot find crtbegin_so.o anywhere on the system."
  echo "   Try: pkg install ndk-sysroot clang"
  echo "   Then re-run this script."
  exit 1
fi
echo "✓ crt objects found at: $CRT_DIR"

# ── Generate a Zig libc file pointing at Termux's Bionic ────────
# CRITICAL: Without this, Zig detects the host as 'aarch64-linux-musl'
# (wrong!) and produces a .so that won't load on Termux. The libc file
# explicitly tells Zig where Termux's Bionic headers + libs live.
#
# Zig's libc file only accepts ONE sys_include_dir, but opentui needs
# BOTH $PREFIX/include (for signal.h, time.h) AND the arch-specific
# $PREFIX/include/aarch64-linux-android (for <asm/sigcontext.h>).
# Workaround: create a merged include dir with symlinks to both.
MERGED_INCLUDE="$REPO_ROOT/.zig-merged-include"
mkdir -p "$MERGED_INCLUDE"
# Symlink everything from $PREFIX/include into the merged dir
for entry in "$TERMUX_INCLUDE"/*; do
  name=$(basename "$entry")
  if [ ! -e "$MERGED_INCLUDE/$name" ]; then
    ln -sf "$entry" "$MERGED_INCLUDE/$name" 2>/dev/null || true
  fi
done
# Also symlink the arch-specific asm/ headers at the top level so
# #include <asm/sigcontext.h> resolves through $MERGED_INCLUDE/asm/
if [ -d "$ASM_DIR" ]; then
  for entry in "$ASM_DIR"/*; do
    name=$(basename "$entry")
    if [ ! -e "$MERGED_INCLUDE/asm/$name" ]; then
      mkdir -p "$MERGED_INCLUDE/asm"
      ln -sf "$entry" "$MERGED_INCLUDE/asm/$name" 2>/dev/null || true
    fi
  done
fi

LIBC_FILE="$REPO_ROOT/packages/core/src/zig/libc-termux.txt"
cat > "$LIBC_FILE" << EOF
include_dir=$MERGED_INCLUDE
sys_include_dir=$MERGED_INCLUDE
crt_dir=$CRT_DIR
msvc_lib_dir=
kernel32_lib_dir=
gcc_dir=
EOF
echo "✓ Generated libc file: $LIBC_FILE"
echo "  → include_dir=$MERGED_INCLUDE (merged: Termux + arch asm/)"
echo "  → crt_dir=$CRT_DIR"

# ── Verify Bionic libs exist (DO NOT create stubs — they break Termux) ─
# Zig's linkLibC() adds -lm -lc -ldl. On Termux/Bionic, libc.so IS the
# real Bionic — but it's often a linker script (text file) that points
# at the real binary. We must NOT overwrite it.
#
# If libm.so or libdl.so are missing (some minimal Termux installs don't
# ship them as separate files — Bionic folds them into libc.so), we
# create SEPARATE stub files in a temp dir (NOT $PREFIX/lib) and add
# that temp dir to the linker search path. This keeps Termux's real
# libs untouched.
LINKER_STUBS_DIR="$REPO_ROOT/.zig-linker-stubs"
mkdir -p "$LINKER_STUBS_DIR"

REAL_LIBC=""
for candidate in \
  "$TERMUX_LIB/libc.so" \
  "$TERMUX_LIB/libc-*.so" \
  "$TERMUX_LIB/libandroid-support.so"; do
  if ls $candidate >/dev/null 2>&1; then
    REAL_LIBC=$(ls $candidate 2>/dev/null | head -1)
    break
  fi
done

if [ -z "$REAL_LIBC" ]; then
  echo "❌ No libc.so found in $TERMUX_LIB — Termux install is broken."
  echo "   Fix: pkg reinstall libc"
  exit 1
fi
echo "✓ Real libc found: $REAL_LIBC"

# Detect the system Bionic path (used for symlinks + direct linking).
SYSTEM_LIB_DIR="/system/lib64"
if [ ! -f "$SYSTEM_LIB_DIR/libc.so" ]; then
  SYSTEM_LIB_DIR="/system/lib"
fi
if [ ! -f "$SYSTEM_LIB_DIR/libc.so" ]; then
  echo "❌ Cannot find libc.so in /system/lib64 or /system/lib"
  echo "   Android system is broken — this should never happen."
  exit 1
fi
SYSTEM_LIBC="$SYSTEM_LIB_DIR/libc.so"
# Resolve the symlink chain — /system/lib64/libc.so → /apex/com.android.runtime/lib64/bionic/libc.so
# ld.lld sometimes can't follow the chain, so we resolve it ourselves.
SYSTEM_LIBC_REAL=$(readlink -f "$SYSTEM_LIBC" 2>/dev/null || echo "$SYSTEM_LIBC")
SYSTEM_LIBM_REAL=$(readlink -f "$SYSTEM_LIB_DIR/libm.so" 2>/dev/null || echo "$SYSTEM_LIBC_REAL")
SYSTEM_LIBDL_REAL=$(readlink -f "$SYSTEM_LIB_DIR/libdl.so" 2>/dev/null || echo "$SYSTEM_LIBC_REAL")
echo "✓ System Bionic (resolved):"
echo "   libc:  $SYSTEM_LIBC_REAL"
echo "   libm:  $SYSTEM_LIBM_REAL"
echo "   libdl: $SYSTEM_LIBDL_REAL"

# Bionic on Termux: libm and libdl symbols are inside libc.so. Termux
# doesn't ship separate libm.so/libdl.so in $PREFIX/lib. We COPY the
# real Bionic .so files into our temp stubs dir (not symlinks — actual
# file copies) so ld.lld's -l flag resolution finds a real ELF file
# with no symlink chain to follow. The stubs dir is in the -L search path.
NEED_EXTRA_L_PATH=""
for libname in libc libm libdl; do
  if [ ! -f "$TERMUX_LIB/${libname}.so" ] && [ ! -L "$TERMUX_LIB/${libname}.so" ]; then
    # Pick the resolved real path for each lib
    case "$libname" in
      libc)  TARGET_REAL="$SYSTEM_LIBC_REAL" ;;
      libm)  TARGET_REAL="$SYSTEM_LIBM_REAL" ;;
      libdl) TARGET_REAL="$SYSTEM_LIBDL_REAL" ;;
    esac
    echo "ℹ️  Copying $TARGET_REAL → $LINKER_STUBS_DIR/${libname}.so"
    cp "$TARGET_REAL" "$LINKER_STUBS_DIR/${libname}.so" 2>/dev/null || {
      # If cp fails (read-only APEX), fall back to symlink
      echo "ℹ️  cp failed, falling back to symlink"
      ln -sf "$TARGET_REAL" "$LINKER_STUBS_DIR/${libname}.so" 2>/dev/null || true
    }
    NEED_EXTRA_L_PATH=1
  fi
done
if [ "$NEED_EXTRA_L_PATH" = "1" ]; then
  echo "✓ Bionic libs prepared in $LINKER_STUBS_DIR"
  ls -la "$LINKER_STUBS_DIR"/ 2>&1
fi

# ── Build ───────────────────────────────────────────────────────
cd "$REPO_ROOT/packages/core/src/zig"

echo ""
echo "🔧 Building libopentui.so natively..."
echo "   Target: aarch64-linux-android (explicit — avoids musl misdetection)"
echo "   Sysroot: $PREFIX (Termux's Bionic)"
echo "   Lib search: $TERMUX_LIB + $LINKER_STUBS_DIR"
echo ""

# Explicit -Dtarget=aarch64-linux-android so Zig doesn't misdetect as musl.
# ZIG_LIBC env var makes Zig read our generated libc file (Bionic paths).
# XINCLI_ANDROID_LIB_SEARCH_PATHS is read by build.zig's addLibraryPath calls
# so ld.lld finds libc/libm/libdl in $PREFIX/lib + the linker-stubs dir.
#
# CRITICAL: Termux does NOT ship libc.so/libm.so/libdl.so in $PREFIX/lib/ —
# they only exist at /system/lib64/. build.zig links them directly by
# absolute path via addObjectFile, reading the paths from these env vars.
export ZIG_LIBC="$LIBC_FILE"
export XINCLI_ANDROID_LIB_PATH="$TERMUX_LIB"
export XINCLI_ANDROID_LIB_SEARCH_PATHS="$TERMUX_LIB:$LINKER_STUBS_DIR"

# Export the system Bionic paths for build.zig's addObjectFile calls.
# Use the RESOLVED real paths so ld.lld doesn't have to follow symlinks.
export XINCLI_ANDROID_LIBC_PATH="$SYSTEM_LIBC_REAL"
export XINCLI_ANDROID_LIBM_PATH="$SYSTEM_LIBM_REAL"
export XINCLI_ANDROID_LIBDL_PATH="$SYSTEM_LIBDL_REAL"
# libc++_shared.so lives in Termux's $PREFIX/lib (from the libc++ package)
export XINCLI_ANDROID_LIBCXX_PATH="$TERMUX_LIB/libc++_shared.so"
echo "✓ Bionic libs (resolved): $SYSTEM_LIBC_REAL"
echo "✓ libc++: $XINCLI_ANDROID_LIBCXX_PATH"

zig build \
  -Dtarget=aarch64-linux-android \
  -Doptimize=ReleaseFast \
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
