#!/data/data/com.termux/files/usr/bin/bash
# ═════════════════════════════════════════════════════════════════
# ANDROIDTUI OpenTUI — Native Termux Build Script
#
# RUN THIS ON YOUR ANDROID PHONE (in Termux).
# Builds libopentui.so natively — no cross-compilation, no NDK.
#
# Prerequisites:
#   pkg install nodejs git clang
#   pkg install zig
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
  echo "   pkg install zig"
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

# Zig 0.16 does not reuse the old package-cache layout populated below and
# its HTTPS client cannot initialize TLS inside termux-docker. Point this
# disposable generated checkout at the exact vendored dependency sources.
ZON_FILE="$REPO_ROOT/packages/core/src/zig/build.zig.zon"
if ! grep -q '\.path = "../../../../.zig-deps/uucode"' "$ZON_FILE"; then
  sed -i \
    -e '/github.com\/jacobsandlund\/uucode/{s|\.url = .*|.path = "../../../../.zig-deps/uucode",|;n;/\.hash = /d;}' \
    -e '/git+https:\/\/github.com\/facebook\/yoga/{s|\.url = .*|.path = "../../../../.zig-deps/yoga",|;n;/\.hash = /d;}' \
    "$ZON_FILE"
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
UUCODE_HASH="uucode-0.2.0-ZZjBPuS4VABmt0lQ-jDiKB4afmuZVvZpbX09FP5JrR8N"
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

# ── Heal a yoga cache left rewritten by an older build script ─────────
#
# This script used to sed yoga's sources in the global Zig cache,
# rewriting std::isinf/isnan/abs into __builtin_* intrinsics. That was a
# workaround for Bionic's math.h defining isinf/isnan as C macros; with
# Termux's libc++ headers on the include path (see ANDROIDTUI_ANDROID_LIBCXX_INCLUDE
# in build.zig) the std:: forms compile fine, so the rewrite is gone.
#
# It has to be undone rather than merely stopped: the cache lives outside
# the repo and survives checkouts, and the old std::abs → __builtin_fabs
# rule was lossy (integer abs silently became double fabs). Restore the
# pristine vendored copy so the build compiles what upstream shipped.
if grep -q "__builtin_" "$ZIG_GLOBAL_CACHE/p/$YOGA_HASH/yoga/numeric/Comparison.h" 2>/dev/null; then
  echo "⚠️  Yoga cache was rewritten by an older build script — restoring pristine source"
  rm -rf "${ZIG_GLOBAL_CACHE:?}/p/$YOGA_HASH"
  cp -r "$DEPS_DIR/yoga" "$ZIG_GLOBAL_CACHE/p/$YOGA_HASH"
  echo "✓ Yoga source restored from $DEPS_DIR/yoga"
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
# we add them via ANDROIDTUI_ANDROID_ASM_INCLUDE env var which build.zig
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
  export ANDROIDTUI_ANDROID_ASM_INCLUDE="$ASM_INCLUDE"
  echo "✓ asm include: $ASM_INCLUDE"
fi

# The translate-c compatibility wrapper needs the real Bionic sys/time.h.
# Fill this path only in the disposable prepared checkout; the tracked
# overlay remains independent of a particular Termux installation prefix.
TRANSLATE_COMPAT_HEADER="$REPO_ROOT/packages/core/src/zig/android-translate-compat/sys/time.h"
sed -i "s|@ANDROIDTUI_SYS_TIME_HEADER@|$TERMUX_INCLUDE/sys/time.h|g" "$TRANSLATE_COMPAT_HEADER"

# ── Prepare Bionic linker inputs without modifying Termux ─────────
# The container's ld.lld cannot reliably stat Android system/APEX paths.
# Disposable linker scripts let it open the system objects directly.
# Never copy Bionic libraries into $PREFIX/lib: loading a second libc
# image into Termux can cause TLS failures.
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
#
for libname in libc libm libdl; do
  case "$libname" in
    libc)  TARGET_REAL="$SYSTEM_LIBC_REAL" ;;
    libm)  TARGET_REAL="$SYSTEM_LIBM_REAL" ;;
    libdl) TARGET_REAL="$SYSTEM_LIBDL_REAL" ;;
  esac
  printf 'INPUT ( %s )\n' "$TARGET_REAL" > "$LINKER_STUBS_DIR/${libname}.so"
done
echo "✓ Bionic linker scripts created in $LINKER_STUBS_DIR (no system libraries copied)"
ls -la "$LINKER_STUBS_DIR"/ 2>&1

# ── Build ───────────────────────────────────────────────────────
cd "$REPO_ROOT/packages/core/src/zig"

echo ""
echo "🔧 Building libopentui.so natively..."
ANDROID_API_LEVEL="${ANDROID_API_LEVEL:-28}"
ANDROID_TARGET="aarch64-linux-android.${ANDROID_API_LEVEL}"
echo "   Target: $ANDROID_TARGET (minimum supported Android API)"
echo "   Sysroot: $PREFIX (Termux's Bionic)"
echo "   Lib search: $TERMUX_LIB + $LINKER_STUBS_DIR"
echo ""

# Explicit API level keeps container builds independent of Android's getprop.
# ZIG_LIBC env var makes Zig read our generated libc file (Bionic paths).
# ANDROIDTUI_ANDROID_LIB_SEARCH_PATHS is read by build.zig's addLibraryPath calls
# so ld.lld finds libc/libm/libdl in $PREFIX/lib + the linker-stubs dir.
export ZIG_LIBC="$LIBC_FILE"
export ANDROIDTUI_ANDROID_LIB_PATH="$TERMUX_LIB"
export ANDROIDTUI_ANDROID_LIB_SEARCH_PATHS="$TERMUX_LIB:$LINKER_STUBS_DIR"

# libc++_shared.so lives in Termux's $PREFIX/lib (from the libc++ package).
# Termux ships no libc++.so, so build.zig links this one by absolute path
# via addObjectFile instead of calling linkLibCpp().
export ANDROIDTUI_ANDROID_LIBCXX_PATH="$TERMUX_LIB/libc++_shared.so"
echo "✓ Bionic libs (resolved): $SYSTEM_LIBC_REAL"
echo "✓ libc++: $ANDROIDTUI_ANDROID_LIBCXX_PATH"

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
  echo "❌ Cannot find libc++ headers (type_traits)."
  echo "   Reinstall Termux's libc++ package: apt install --reinstall libc++"
  exit 1
fi
export ANDROIDTUI_ANDROID_LIBCXX_INCLUDE="$LIBCXX_INCLUDE"
# Some libc++ setups have __config in a separate dir
LIBCXX_INCLUDE2=$(dirname "$LIBCXX_INCLUDE" 2>/dev/null)
if [ -d "$LIBCXX_INCLUDE2" ]; then
  export ANDROIDTUI_ANDROID_LIBCXX_INCLUDE2="$LIBCXX_INCLUDE2"
fi
echo "✓ libc++ headers: $LIBCXX_INCLUDE"

# Run zig build with --summary all to see all steps + errors
# Force clean first to avoid cached results that don't output the .so
echo "Cleaning previous build cache..."
rm -rf "$REPO_ROOT/packages/core/src/zig/zig-out" "$REPO_ROOT/packages/core/src/zig/.zig-cache" 2>/dev/null || true

zig build \
  -Dtarget="$ANDROID_TARGET" \
  -Doptimize=ReleaseFast \
  --summary all
ZIG_EXIT=$?
echo "zig build exit code: $ZIG_EXIT"
if [ $ZIG_EXIT -ne 0 ]; then
  echo "=== Build failed. Re-running with verbose to see the actual error ==="
  zig build \
    -Dtarget="$ANDROID_TARGET" \
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

OUT_DIR="$REPO_ROOT/packages/core/prebuilt/aarch64-android"
mkdir -p "$OUT_DIR"
cp "$SO_PATH" "$OUT_DIR/libopentui.so"

# No symbol renaming — __ndk1 is correct (matches Termux's libc++)

# ── Verify the .so matches this checkout's FFI declarations ─────────────
#
# The single most likely failure after an upstream bump is a .so built
# from older sources: it loads, then dies at the first missing symbol
# with "Symbol <name> not found". Catch it here, while the toolchain is
# still warm, instead of at runtime or in CI.
echo ""
echo "🔍 Verifying FFI symbols against src/zig.ts..."
SYM_TMP="$(mktemp -d "${TMPDIR:-/tmp}/androidtui-sym.XXXXXX")"
if bun -e '
  const fs = require("fs");
  const src = fs.readFileSync(process.argv[1], "utf8");
  const start = src.indexOf("dlopen(resolvedLibPath");
  if (start === -1) throw new Error("could not find the dlopen() symbol table");
  const end = src.indexOf("\n  })", start);
  const table = src.slice(start, end === -1 ? undefined : end);
  const names = [...new Set(
    [...table.matchAll(/^ {4}([A-Za-z_][A-Za-z0-9_]*): \{/gm)].map((m) => m[1]),
  )];
  if (names.length === 0) throw new Error("extracted 0 symbols");
  process.stdout.write(names.join("\n") + "\n");
' "$REPO_ROOT/packages/core/src/zig.ts" > "$SYM_TMP/declared.txt" 2>"$SYM_TMP/err"; then
  nm -D --defined-only "$OUT_DIR/libopentui.so" 2>/dev/null | awk '{print $NF}' | sort -u > "$SYM_TMP/exported.txt"
  MISSING_SYMS="$(comm -23 <(sort -u "$SYM_TMP/declared.txt") "$SYM_TMP/exported.txt")"
  if [ -n "$MISSING_SYMS" ]; then
    echo "  ❌ The .so does not export every symbol src/zig.ts declares:"
    printf '       %s\n' $MISSING_SYMS
    echo "     This build is stale or incomplete — do NOT commit it."
    rm -rf "$SYM_TMP"
    exit 1
  fi
  echo "  ✓ all $(wc -l < "$SYM_TMP/declared.txt" | tr -d ' ') declared symbols present"
else
  echo "  ⚠️  could not extract symbols; skipping check"
  cat "$SYM_TMP/err" 2>/dev/null | sed 's/^/     /'
fi
rm -rf "$SYM_TMP"

# ── Report ─────────────────────────────────────────────────────────────

ANDROIDTUI_VERSION="$(bun -e "console.log(require('$REPO_ROOT/packages/core/package.json').version)" 2>/dev/null || echo "")"
ANDROIDTUI_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  ✅ NATIVE BUILD COMPLETE                                     ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Output:  packages/core/prebuilt/aarch64-android/libopentui.so"
echo "  Size:    $(du -h "$OUT_DIR/libopentui.so" | cut -f1)"
[ -n "$ANDROIDTUI_VERSION" ] && echo "  Version: $ANDROIDTUI_VERSION"
echo ""
echo "  ── Publish all five @androidtui packages ─────────────────────────"
echo ""
echo "    git add -A"
echo "    git commit -m 'build: native arm64 .so from Termux'"

if [ -n "$ANDROIDTUI_VERSION" ]; then
  echo "    git push origin ${ANDROIDTUI_BRANCH:-HEAD}"
  echo "    git tag androidtui-v$ANDROIDTUI_VERSION && git push origin androidtui-v$ANDROIDTUI_VERSION"
  echo ""
  echo "  That one tag runs .github/workflows/androidtui-release.yml, which"
  echo "  publishes — in dependency order, all at $ANDROIDTUI_VERSION:"
  echo ""
  echo "    1. @androidtui/core-android-arm64   (this .so)"
  echo "    2. @androidtui/core"
  echo "    3. @androidtui/{react,solid,keymap}  (in parallel)"
  echo ""
  echo "  npm versions are immutable — the workflow refuses to start if"
  echo "  $ANDROIDTUI_VERSION is already published. Check first with:"
  echo ""
  echo "    npm view @androidtui/core@$ANDROIDTUI_VERSION version"
else
  echo "    git push origin ${ANDROIDTUI_BRANCH:-HEAD}"
  echo "    git tag androidtui-v<version> && git push origin androidtui-v<version>"
fi
echo ""
