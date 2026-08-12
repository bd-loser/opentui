#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# androidtui-regen.sh — regenerate the patch kit from the current working tree.
#
#   bash scripts/androidtui-regen.sh
#
# Run this after a successful port. It rewrites patches/mod/*.patch as
# diffs against the CURRENT upstream tag and refreshes patches/add/**
# from the tree, so the kit's base moves forward with you.
#
# That is the whole trick to keeping this cheap: if the kit's base is
# always the last version you shipped, the next upstream release is one
# small hop away instead of an ever-growing pile of drift.
#
# It also reports drift — any file that differs from upstream but is in
# neither the add list, the mod list, nor the ignore list. Unreported
# drift is how a fork silently becomes unmaintainable.
#
# Flags:
#   --base <tag>   diff against this tag (default: from the branch name)
#   --check        report only, write nothing; non-zero exit if stale
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

GREP="$(command -v grep)"
FIND="$(command -v find)"
SORT="$(command -v sort)"

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok()   { printf '  \033[32mok\033[0m  %s\n' "$*"; }

BASE=""
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base)    BASE="${2:-}"; shift 2 ;;
    --check)   CHECK=1; shift ;;
    -h|--help) "$GREP" '^#' "$0" | cut -c3-; exit 0 ;;
    *)         die "unknown argument: $1" ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$ROOT"
[ -f patches/meta.json ] || die "patches/meta.json not found"

# ── figure out the base tag ───────────────────────────────────────────

if [ -z "$BASE" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  case "$BRANCH" in
    androidtui/*) BASE="v${BRANCH#androidtui/}" ;;
    *)     die "cannot infer the base tag from branch '$BRANCH'. Pass --base vX.Y.Z." ;;
  esac
fi

git rev-parse -q --verify "refs/tags/$BASE" >/dev/null || die "tag $BASE not found"
VERSION="${BASE#v}"
info "regenerating kit against $BASE"

# ── read the manifest ─────────────────────────────────────────────────

read_list() {
  node -e '
    const fs = require("fs");
    const meta = JSON.parse(fs.readFileSync("patches/meta.json", "utf8"));
    process.stdout.write((meta[process.argv[1]] ?? []).join("\n"));
  ' "$1"
}

MOD_LIST="$(read_list mod)"
ADD_LIST="$(read_list add)"

# ── regenerate mod patches ────────────────────────────────────────────

info "mod/ — diffs against $BASE"
STALE=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/androidtui-regen.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

while IFS= read -r f; do
  [ -n "$f" ] || continue
  out="patches/mod/$f.patch"
  git diff "$BASE" -- "$f" > "$TMP/patch"

  if [ ! -s "$TMP/patch" ]; then
    warn "$f is identical to $BASE — it no longer needs a patch. Remove it from meta.json's mod list."
    continue
  fi

  if [ -f "$out" ] && cmp -s "$TMP/patch" "$out"; then
    ok "$f (unchanged)"
    continue
  fi

  STALE=1
  if [ "$CHECK" -eq 1 ]; then
    printf '  \033[33mstale\033[0m %s\n' "$f"
  else
    mkdir -p "$(dirname "$out")"
    cp "$TMP/patch" "$out"
    printf '  \033[32mwrote\033[0m %s (%s bytes)\n' "$f" "$(wc -c < "$out" | tr -d ' ')"
  fi
done <<< "$MOD_LIST"

# ── refresh additive files ────────────────────────────────────────────

info "add/ — verbatim copies from the tree"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || { warn "$f is listed in meta.json but missing from the tree"; STALE=1; continue; }

  dest="patches/add/$f"
  if [ -f "$dest" ] && cmp -s "$f" "$dest"; then
    ok "$f (unchanged)"
    continue
  fi

  STALE=1
  if [ "$CHECK" -eq 1 ]; then
    printf '  \033[33mstale\033[0m %s\n' "$f"
  else
    mkdir -p "$(dirname "$dest")"
    cp -p "$f" "$dest"
    printf '  \033[32mwrote\033[0m %s\n' "$f"
  fi
done <<< "$ADD_LIST"

# ── drop kit files that are no longer listed ──────────────────────────

if [ "$CHECK" -eq 0 ]; then
  while IFS= read -r stray; do
    [ -n "$stray" ] || continue
    rel="${stray#patches/add/}"
    printf '%s\n' "$ADD_LIST" | "$GREP" -qxF "$rel" && continue
    warn "removing patches/add/$rel — not in meta.json's add list"
    rm -f "$stray"
  done < <("$FIND" patches/add -type f 2>/dev/null | "$SORT")

  while IFS= read -r stray; do
    [ -n "$stray" ] || continue
    rel="${stray#patches/mod/}"; rel="${rel%.patch}"
    printf '%s\n' "$MOD_LIST" | "$GREP" -qxF "$rel" && continue
    warn "removing patches/mod/$rel.patch — not in meta.json's mod list"
    rm -f "$stray"
  done < <("$FIND" patches/mod -name '*.patch' -type f 2>/dev/null | "$SORT")

  "$FIND" patches -type d -empty -delete 2>/dev/null || true
fi

# ── drift detection ───────────────────────────────────────────────────
#
# Anything that differs from upstream and is not accounted for is a
# change that would be silently lost on the next port.

info "drift — changed vs $BASE but not in the kit"
IGNORE="$(read_list ignore)"
DRIFT=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  printf '%s\n' "$MOD_LIST" | "$GREP" -qxF "$f" && continue
  printf '%s\n' "$ADD_LIST" | "$GREP" -qxF "$f" && continue

  skip=0
  while IFS= read -r ig; do
    [ -n "$ig" ] || continue
    case "$ig" in
      */) case "$f" in "$ig"*) skip=1; break ;; esac ;;
      *)  [ "$f" = "$ig" ] && { skip=1; break; } ;;
    esac
  done <<< "$IGNORE"
  [ "$skip" -eq 1 ] && continue

  printf '  \033[33mdrift\033[0m %s\n' "$f"
  DRIFT=$((DRIFT + 1))
done < <(git diff --name-only "$BASE" -- . | "$SORT")

if [ "$DRIFT" -eq 0 ]; then
  ok "none"
else
  warn "$DRIFT file(s) differ from $BASE but are not in the kit.
       Add them to meta.json (mod or add) or to ignore, then re-run —
       otherwise those edits vanish on the next port."
fi

# ── package.json check ────────────────────────────────────────────────

info "package.json transform"
if node patches/apply-package-json.mjs --check >/dev/null 2>&1; then
  ok "tree matches the transform"
else
  warn "the four package.json files do not match what the transform produces.
       Run: node patches/apply-package-json.mjs"
  STALE=1
fi

# ── stamp the base ────────────────────────────────────────────────────

if [ "$CHECK" -eq 0 ]; then
  node -e '
    const fs = require("fs");
    const meta = JSON.parse(fs.readFileSync("patches/meta.json", "utf8"));
    meta.base = { version: process.argv[1], tag: process.argv[2] };
    delete meta.appliedTo;
    fs.writeFileSync("patches/meta.json", JSON.stringify(meta, null, 2) + "\n");
  ' "$VERSION" "$BASE"
  ok "meta.json base = $BASE"
fi

echo
if [ "$CHECK" -eq 1 ] && { [ "$STALE" -eq 1 ] || [ "$DRIFT" -gt 0 ]; }; then
  die "kit is out of date — run without --check"
fi
printf '\033[1mkit regenerated against %s\033[0m\n' "$BASE"
