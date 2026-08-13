#!/data/data/com.termux/files/usr/bin/bash
# ═════════════════════════════════════════════════════════════════
# vendor-deps.sh — Pre-fetch Zig deps so builds work offline
#
# Run this ONCE on a machine with good network (your laptop, or your
# phone on WiFi). It downloads yoga + uucode into .zig-deps/ so
# build-native-termux.sh doesn't need network during the build.
#
# Run from the repo root:
#   bash packages/core/scripts/vendor-deps.sh
# ═════════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEPS_DIR="$REPO_ROOT/.zig-deps"

mkdir -p "$DEPS_DIR"

# ── uucode ──────────────────────────────────────────────────────
UUCODE_URL="https://github.com/jacobsandlund/uucode/archive/84ceda8561a17ba4a9b96ac5c583f779660bbd4e.tar.gz"
UUCODE_DIR="$DEPS_DIR/uucode"

if [ -d "$UUCODE_DIR" ]; then
  echo "✓ uucode already vendored at $UUCODE_DIR"
else
  echo "📦 Downloading uucode..."
  # Retry up to 3 times — mobile DNS can be flaky
  for attempt in 1 2 3; do
    if curl -fsSL --retry 3 --retry-delay 2 "$UUCODE_URL" | tar xz -C "$DEPS_DIR"; then
      mv "$DEPS_DIR/uucode-84ceda8561a17ba4a9b96ac5c583f779660bbd4e" "$UUCODE_DIR" 2>/dev/null || true
      echo "✓ uucode downloaded"
      break
    else
      echo "⚠️  Attempt $attempt failed, retrying in 5s..."
      sleep 5
    fi
  done
  if [ ! -d "$UUCODE_DIR" ]; then
    echo "❌ Failed to download uucode after 3 attempts."
    echo "   Check your network connection and try again."
    exit 1
  fi
fi

# ── yoga ────────────────────────────────────────────────────────
YOGA_DIR="$DEPS_DIR/yoga"

if [ -d "$YOGA_DIR" ]; then
  echo "✓ yoga already vendored at $YOGA_DIR"
else
  echo "📦 Downloading yoga v3.2.1..."
  YOGA_URL="https://github.com/facebook/yoga/archive/refs/tags/v3.2.1.tar.gz"
  for attempt in 1 2 3; do
    if curl -fsSL --retry 3 --retry-delay 2 "$YOGA_URL" | tar xz -C "$DEPS_DIR"; then
      mv "$DEPS_DIR/yoga-3.2.1" "$YOGA_DIR" 2>/dev/null || true
      echo "✓ yoga downloaded"
      break
    else
      echo "⚠️  Attempt $attempt failed, retrying in 5s..."
      sleep 5
    fi
  done
  if [ ! -d "$YOGA_DIR" ]; then
    echo "❌ Failed to download yoga after 3 attempts."
    exit 1
  fi
fi

echo ""
echo "✅ All deps vendored to $DEPS_DIR"
echo "   Now run: bash packages/core/scripts/build-native-termux.sh"
