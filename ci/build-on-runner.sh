#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must be set}"

OUT_HOST="$GITHUB_WORKSPACE/.work/native-artifacts"
mkdir -p "$OUT_HOST"
chmod 0777 "$OUT_HOST"

docker run --rm \
  -v "$GITHUB_WORKSPACE:/workspace:ro" \
  -v "$OUT_HOST:/out" \
  -v "$GITHUB_WORKSPACE/ci/getprop:/system/bin/getprop:ro" \
  -w /workspace \
  termux/termux-docker:aarch64 \
  bash /workspace/ci/build-in-container.sh

test -s "$OUT_HOST/libopentui.so"
test "$(find "$OUT_HOST/packages" -name '*.tgz' -type f | wc -l)" -eq 8
file "$OUT_HOST/libopentui.so"
(cd "$OUT_HOST" && sha256sum -c SHA256SUMS)
