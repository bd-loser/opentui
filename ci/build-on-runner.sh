#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must be set}"

OUT_HOST="$GITHUB_WORKSPACE/.work/native-artifacts"
mkdir -p "$OUT_HOST"
chmod 0777 "$OUT_HOST"

docker run --rm \
  -v "$GITHUB_WORKSPACE:/workspace:ro" \
  -v "$OUT_HOST:/out" \
  -w /workspace \
  termux/termux-docker:aarch64 \
  bash /workspace/ci/build-in-container.sh

test -s "$OUT_HOST/libopentui.so"
file "$OUT_HOST/libopentui.so"
sha256sum -c "$OUT_HOST/SHA256SUMS"
