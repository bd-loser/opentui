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

# ── XINCLI: Patch uucode's build.zig so uucode_build_tables uses our
# target (aarch64-linux-android) instead of b.graph.host (misdetected as
# aarch64-linux-musl on Termux, which fails to link -lm -lc -ldl).
# Idempotent — safe to re-run.
UUCODE_BUILD_ZIG="$ZIG_GLOBAL_CACHE/p/$UUCODE_HASH/build.zig"
if [ -f "$UUCODE_BUILD_ZIG" ] && ! grep -q "XINCLI-patched\|target: std.Build.ResolvedTarget," "$UUCODE_BUILD_ZIG"; then
  echo "🔧 Patching uucode/build.zig for Android target..."
  # 1. Add target param to buildTables signature
  sed -i 's|^fn buildTables(\s*$|fn buildTables(\n    // XINCLI-patched: accept target|' "$UUCODE_BUILD_ZIG"
  sed -i 's|^    b: \*std\.Build,\s*$|    b: *std.Build,\n    target: std.Build.ResolvedTarget,|' "$UUCODE_BUILD_ZIG"
  # 2. Drop the local `const target = b.graph.host;`
  sed -i 's|^    const target = b\.graph\.host;.*$|    // XINCLI-patched: target is now a parameter|' "$UUCODE_BUILD_ZIG"
  # 3. Replace remaining `b.graph.host` reference for build_tables_mod
  sed -i 's|\.target = b\.graph\.host,|.target = target,|g' "$UUCODE_BUILD_ZIG"
  # 4. Update the call site in createLibMod
  sed -i 's|buildTables(b, build_config_path, build_tables_optimize)|buildTables(b, target, build_config_path, build_tables_optimize)|' "$UUCODE_BUILD_ZIG"

  if grep -q "target: std.Build.ResolvedTarget" "$UUCODE_BUILD_ZIG"; then
    echo "✓ uucode/build.zig patched (target threaded through)"
  else
    echo "⚠️  uucode patch may not have applied — check $UUCODE_BUILD_ZIG"
  fi
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

# ── Patch yoga source: replace std::isinf/isnan/abs with __builtin_* ──
# NUCLEAR OPTION: Bionic's math.h defines isinf/isnan as C macros that
# break ALL attempts to use std::isinf in C++. No compiler flag, wrapper
# header, or macro game can fix this because the preprocessor always wins.
#
# Fix: sed-patch yoga's source files to replace the problematic std::
# calls with __builtin_* compiler intrinsics. These are always available,
# never macros, and don't depend on any header.
#
# IMPORTANT: std::abs can be int or float. __builtin_abs is INT-ONLY.
# Use __builtin_fabs for abs — it works for ALL numeric types (int,
# float, double) via implicit conversion, and returns double which
# compares correctly with < 0.0001.
#
# CRITICAL: Clear the Zig cache for yoga first, so we get FRESH source.
# Previous runs may have already patched std::abs → __builtin_abs (wrong),
# and the sed for std::abs won't match anymore. Clearing forces a re-fetch.
YOGA_DIR=$(find "$HOME/.cache/zig/p" -maxdepth 1 -name "N-V-*" -type d 2>/dev/null | head -1)
if [ -n "$YOGA_DIR" ] && [ -d "$YOGA_DIR/yoga" ]; then
  # Check if already patched (has __builtin_abs from a previous run)
  if grep -q "__builtin_abs(" "$YOGA_DIR/yoga/numeric/Comparison.h" 2>/dev/null; then
    echo "⚠️  Yoga source has stale patches from previous run — re-fetching fresh copy"
    rm -rf "$YOGA_DIR"
    # Re-populate from vendored deps
    ZIG_GLOBAL_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/zig"
    YOGA_HASH="N-V-__8AAOYl0gAU76B1VRPFD9AWvy2VkOef2jN0B3sISTeO"
    if [ -d "$REPO_ROOT/.zig-deps/yoga" ]; then
      cp -r "$REPO_ROOT/.zig-deps/yoga" "$ZIG_GLOBAL_CACHE/p/$YOGA_HASH"
      YOGA_DIR="$ZIG_GLOBAL_CACHE/p/$YOGA_HASH"
    fi
  fi
fi

if [ -n "$YOGA_DIR" ] && [ -d "$YOGA_DIR/yoga" ]; then
  echo "🔧 Patching yoga source: std::isinf → __builtin_isinf etc."
  find "$YOGA_DIR/yoga" -name "*.h" -o -name "*.cpp" | while read f; do
    sed -i \
      -e 's/std::isinf(/__builtin_isinf(/g' \
      -e 's/std::isnan(/__builtin_isnan(/g' \
      -e 's/std::isfinite(/__builtin_isfinite(/g' \
      -e 's/std::signbit(/__builtin_signbit(/g' \
      -e 's/std::abs(/__builtin_fabs(/g' \
      -e 's/std::fabs(/__builtin_fabs(/g' \
      -e 's/std::fpclassify(/__builtin_fpclassify(/g' \
      "$f" 2>/dev/null || true
  done
  # Verify the patch took effect
  if grep -q "__builtin_fabs(" "$YOGA_DIR/yoga/numeric/Comparison.h" 2>/dev/null; then
    echo "✓ Yoga source patched (verified: __builtin_fabs in Comparison.h)"
  else
    echo "⚠️  Patch may not have applied — Comparison.h still doesn't have __builtin_fabs"
    grep -n "abs\|isinf" "$YOGA_DIR/yoga/numeric/Comparison.h" 2>/dev/null | head -5
  fi
else
  echo "⚠️  Yoga dir not found — skipping patch"
fi

# ── Generate a Zig libc file pointing at Termux's Bionic ────────
# CRITICAL: Without this, Zig detects the host as 'aarch64-linux-musl'
# (wrong!) and produces a .so that won't load on Termux. The libc file
# explicitly tells Zig where Termux's Bionic headers + libs live.
#
# The libc file's include_dir is used by BOTH @cImport (C) AND the C++
# compiler. So we point it at Termux's REAL $PREFIX/include which has
# proper C/C++ header separation (math.h doesn't pollute C++ std::).
#
# For the arch-specific asm/ headers (asm/sigcontext.h, asm/types.h),
# we add them via XINCLI_ANDROID_ASM_INCLUDE env var which build.zig
# passes to @cImport only (not C++ compilation).
LIBC_FILE="$REPO_ROOT/packages/core/src/zig/libc-termux.txt"
cat > "$LIBC_FILE" << EOF
include_dir=$TERMUX_INCLUDE
sys_include_dir=$TERMUX_INCLUDE
crt_dir=$CRT_DIR
msvc_lib_dir=
kernel32_lib_dir=
gcc_dir=
EOF
echo "✓ Generated libc file: $LIBC_FILE"
echo "  → include_dir=$TERMUX_INCLUDE (Termux real include — proper C/C++ separation)"
echo "  → crt_dir=$CRT_DIR"

# ── Set up asm include path for @cImport ────────────────────────
# The asm/ headers (asm/sigcontext.h, asm/types.h) live at
# $PREFIX/include/aarch64-linux-android/asm/. @cImport needs them but
# they're not in $PREFIX/include directly. We export the path so
# build.zig can add it via addSystemIncludePath for @cImport only.
ASM_INCLUDE="$TERMUX_INCLUDE/aarch64-linux-android"
if [ -d "$ASM_INCLUDE" ]; then
  export XINCLI_ANDROID_ASM_INCLUDE="$ASM_INCLUDE"
  echo "✓ asm include: $ASM_INCLUDE"
fi

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
# doesn't ship separate libm.so/libdl.so in $PREFIX/lib. We create
# LINKER SCRIPTS (not symlinks) in our temp stubs dir. The scripts use
# ABSOLUTE paths to the APEX .so files so ld.lld opens them directly
# via open() — bypassing the stat() call that fails on /apex/ due to
# Android's restricted mount namespace.
#
# Format: INPUT ( /absolute/path/to/lib.so )
# ld.lld reads this as a linker script and opens the absolute path.
NEED_EXTRA_L_PATH=""
for libname in libc libm libdl; do
  if [ ! -f "$TERMUX_LIB/${libname}.so" ] && [ ! -L "$TERMUX_LIB/${libname}.so" ]; then
    # Pick the resolved real path for each lib
    case "$libname" in
      libc)  TARGET_REAL="$SYSTEM_LIBC_REAL" ;;
      libm)  TARGET_REAL="$SYSTEM_LIBM_REAL" ;;
      libdl) TARGET_REAL="$SYSTEM_LIBDL_REAL" ;;
    esac
    # rm -f first — previous runs may have left a broken symlink
    rm -f "$LINKER_STUBS_DIR/${libname}.so" 2>/dev/null || true
    rm -f "$TERMUX_LIB/${libname}.so" 2>/dev/null || true
    # Copy the real .so via dd (open/read/write — bypasses stat())
    echo "ℹ️  Copying $TARGET_REAL → $TERMUX_LIB/${libname}.so (Termux lib dir)"
    dd if="$TARGET_REAL" of="$TERMUX_LIB/${libname}.so" bs=1M 2>&1 | tail -2
    # Also copy to stubs dir as backup
    dd if="$TARGET_REAL" of="$LINKER_STUBS_DIR/${libname}.so" bs=1M 2>/dev/null || true
    # Verify the copy is a real ELF (check file size > 1000 bytes)
    FILE_SIZE=$(wc -c < "$TERMUX_LIB/${libname}.so" 2>/dev/null || echo "0")
    echo "  → $libname.so size: $FILE_SIZE bytes at $TERMUX_LIB/"
    NEED_EXTRA_L_PATH=1
  fi
done
if [ "$NEED_EXTRA_L_PATH" = "1" ]; then
  echo "✓ Bionic linker scripts created in $LINKER_STUBS_DIR"
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
# Include path for @cImport — points at the merged-include dir that has
# both Termux's headers (pthread.h, math.h, signal.h) and arch-specific
# asm/ headers (asm/sigcontext.h, asm/types.h).
export XINCLI_ANDROID_INCLUDE_PATH="$MERGED_INCLUDE"
# Math.h wrapper dir — placed FIRST in C++ include path to shadow
# Bionic's math.h and #undef the isinf/isnan/fabs/abs macros.
export XINCLI_ANDROID_MATH_WRAPPER="$WRAPPER_MATH"
# cmath wrapper dir — shadows <cmath>, #undefs macros AFTER <cmath> runs
export XINCLI_ANDROID_CMATH_WRAPPER="$WRAPPER_INCLUDE"

# Export the system Bionic paths for build.zig's addObjectFile calls.
# Use the RESOLVED real paths so ld.lld doesn't have to follow symlinks.
export XINCLI_ANDROID_LIBC_PATH="$SYSTEM_LIBC_REAL"
export XINCLI_ANDROID_LIBM_PATH="$SYSTEM_LIBM_REAL"
export XINCLI_ANDROID_LIBDL_PATH="$SYSTEM_LIBDL_REAL"
# libc++_shared.so lives in Termux's $PREFIX/lib (from the libc++ package)
export XINCLI_ANDROID_LIBCXX_PATH="$TERMUX_LIB/libc++_shared.so"
echo "✓ Bionic libs (resolved): $SYSTEM_LIBC_REAL"
echo "✓ libc++: $XINCLI_ANDROID_LIBCXX_PATH"

# ── Find libc++ headers for C++ compilation ─────────────────────
# Yoga's C++ files need <type_traits>, <cstddef>, etc. from libc++.
# We skipped linkLibCpp() for android, so we must add the include path manually.
# Termux's libc++ package puts headers at $PREFIX/include/c++/v1/
LIBCXX_INCLUDE=""
for candidate in \
  "$PREFIX/include/c++/v1" \
  "$PREFIX/include/c++"/*/v1 \
  "$PREFIX/include"/*/c++/v1; do
  if [ -f "$candidate/type_traits" ] 2>/dev/null; then
    LIBCXX_INCLUDE=$(echo $candidate | head -1)
    break
  fi
done

if [ -z "$LIBCXX_INCLUDE" ]; then
  echo "📦 libc++ headers not found — installing libc++-dev..."
  pkg install -y libc++-dev 2>&1 | tail -3 || true
  for candidate in \
    "$PREFIX/include/c++/v1" \
    "$PREFIX/include/c++"/*/v1 \
    "$PREFIX/include"/*/c++/v1; do
    if [ -f "$candidate/type_traits" ] 2>/dev/null; then
      LIBCXX_INCLUDE=$(echo $candidate | head -1)
      break
    fi
  done
fi

if [ -z "$LIBCXX_INCLUDE" ]; then
  echo "❌ Cannot find libc++ headers (type_traits)."
  echo "   Try: pkg install libc++-dev"
  exit 1
fi
export XINCLI_ANDROID_LIBCXX_INCLUDE="$LIBCXX_INCLUDE"
# Some libc++ setups have __config in a separate dir
LIBCXX_INCLUDE2=$(dirname "$LIBCXX_INCLUDE" 2>/dev/null)
if [ -d "$LIBCXX_INCLUDE2" ]; then
  export XINCLI_ANDROID_LIBCXX_INCLUDE2="$LIBCXX_INCLUDE2"
fi
# Termux's real include dir — used for C++ compilation (proper C/C++ separation).
# The merged-include dir is only for Zig @cImport (C-only) because its math.h
# macro 'isinf' breaks std::isinf in C++ context.
export XINCLI_ANDROID_TERMUX_INCLUDE="$TERMUX_INCLUDE"
echo "✓ libc++ headers: $LIBCXX_INCLUDE"
echo "✓ Termux include (C++): $TERMUX_INCLUDE"

# Run zig build with --summary all to see all steps + errors
# Force clean first to avoid cached results that don't output the .so
echo "Cleaning previous build cache..."
rm -rf "$REPO_ROOT/packages/core/src/zig/zig-out" "$REPO_ROOT/packages/core/src/zig/.zig-cache" 2>/dev/null || true

zig build \
  -Dtarget=aarch64-linux-android \
  -Doptimize=ReleaseFast \
  --summary all
ZIG_EXIT=$?
echo "zig build exit code: $ZIG_EXIT"
if [ $ZIG_EXIT -ne 0 ]; then
  echo "=== Build failed. Re-running with verbose to see the actual error ==="
  zig build \
    -Dtarget=aarch64-linux-android \
    -Doptimize=ReleaseFast \
    --summary all \
    --verbose
fi

# ── No symbol renaming needed ───────────────────────────────────
# Termux's libc++_shared.so ALSO uses __ndk1 namespace! The original
# __ndk1 symbols are correct — they match Termux's libc++. The only
# problem was the TLS crash from NEEDED: libc.so, which is now fixed
# by RUNPATH: /system/lib64.
echo "✓ No symbol renaming needed (Termux libc++ uses __ndk1 too)"
# The install step uses dest_dir "../lib/{output_name}" which puts the .so
# at zig-out/lib/aarch64-android/libopentui.so (outside the default zig-out/)
# Search broadly: zig-out/, .zig-cache/, and parent directories
echo "Searching for libopentui.so..."
find "$REPO_ROOT/packages/core/src/zig" -name "libopentui*.so" -ls 2>/dev/null || echo "  (find in src/zig returned nothing)"
# Also search the zig global cache
find "$HOME/.cache/zig" -name "libopentui*.so" -ls 2>/dev/null || true

SO_PATH=""
for candidate in \
  "$REPO_ROOT/packages/core/src/zig/zig-out/lib/libopentui.so" \
  "$REPO_ROOT/packages/core/src/zig/zig-out/libopentui.so" \
  "$REPO_ROOT/packages/core/src/zig/zig-out/lib/aarch64-android/libopentui.so" \
  "$REPO_ROOT/packages/core/src/zig/lib/aarch64-android/libopentui.so" \
  "$REPO_ROOT/packages/core/lib/aarch64-android/libopentui.so" \
  "$REPO_ROOT/lib/aarch64-android/libopentui.so" \
  "$(find "$REPO_ROOT" -name 'libopentui*.so' -not -path '*/prebuilt/*' 2>/dev/null | head -1)"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
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

# ── Remove Bionic .so copies from $PREFIX/lib after build ──────
# These were needed for BUILD (linking) but must NOT be present at RUNTIME.
# At runtime, the linker searches RUNPATH ($PREFIX/lib first) and finds
# these copies (from /apex/) which cause TLS crash on dlopen because
# Bionic libc is already loaded in the process.
#
# At runtime, the linker should find libc.so at /system/lib64 (second in
# RUNPATH) — which is the SAME libc already loaded, so no re-load = no crash.
#
# Only libc++_shared.so should remain in $PREFIX/lib (Termux's version).
echo "🧹 Removing Bionic .so copies from $PREFIX/lib (runtime TLS fix)..."
rm -f "$TERMUX_LIB/libc.so" 2>/dev/null && echo "  ✓ Removed libc.so" || true
rm -f "$TERMUX_LIB/libm.so" 2>/dev/null && echo "  ✓ Removed libm.so" || true
rm -f "$TERMUX_LIB/libdl.so" 2>/dev/null && echo "  ✓ Removed libdl.so" || true
echo "  Remaining in $PREFIX/lib:"
ls -la "$TERMUX_LIB"/libc*.so "$TERMUX_LIB"/libm*.so "$TERMUX_LIB"/libdl*.so 2>/dev/null || echo "    (none — good!)"
OUT_DIR="$REPO_ROOT/packages/core/prebuilt/aarch64-android"
mkdir -p "$OUT_DIR"
cp "$SO_PATH" "$OUT_DIR/libopentui.so"

# No symbol renaming — __ndk1 is correct (matches Termux's libc++)

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
