#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# xin-patch.sh — apply the ANDROIDTUI Android/Termux patch kit to any
#                upstream OpenTUI release.
#
#   bash scripts/xin-patch.sh 0.5.1
#
# Creates branch xin/0.5.1 from upstream tag v0.5.1, lays the kit down on
# top of it, and tells you what conflicted (if anything).
#
# The point of the kit is that this repo is NOT a permanently-diverged
# fork. Everything the fork adds lives in patches/, so a new upstream
# release costs one command plus whatever hunks genuinely conflict —
# rather than a 40-commit rebase.
#
# After this succeeds:
#   1. bun install
#   2. bash packages/core/scripts/build-native-termux.sh   (on-device)
#   3. bash scripts/xin-regen.sh    — moves the kit's base to this version
#   4. commit, then: git tag xin-v0.5.1 && git push origin xin-v0.5.1
#
# Flags:
#   --remote <name>     upstream remote (default: auto-detect)
#   --force             overwrite an existing xin/<version> branch and
#                       skip the clean-tree check
#   --no-fetch          skip `git fetch --tags`
#   --skip-npm-check    don't ask npm whether the version is burned
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# Some interactive shells alias or shadow these; always use the real ones.
GREP="$(command -v grep)"
FIND="$(command -v find)"
SORT="$(command -v sort)"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok()   { printf '  \033[32mok\033[0m  %s\n' "$*"; }

VERSION=""
REMOTE=""
FORCE=0
NO_FETCH=0
SKIP_NPM=0

while [ $# -gt 0 ]; do
  case "$1" in
    --remote)         REMOTE="${2:-}"; shift 2 ;;
    --force)          FORCE=1; shift ;;
    --no-fetch)       NO_FETCH=1; shift ;;
    --skip-npm-check) SKIP_NPM=1; shift ;;
    -h|--help)        "$GREP" '^#' "$0" | cut -c3-; exit 0 ;;
    -*)               die "unknown flag: $1" ;;
    *)
      [ -z "$VERSION" ] || die "unexpected argument: $1"
      VERSION="$1"; shift ;;
  esac
done

[ -n "$VERSION" ] || die "usage: bash scripts/xin-patch.sh <version>   (e.g. 0.5.1)"
VERSION="${VERSION#v}"
printf '%s' "$VERSION" | "$GREP" -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$' \
  || die "'$VERSION' is not a semver version"

TAG="v$VERSION"
BRANCH="xin/$VERSION"

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$ROOT"

[ -d patches ] || die "patches/ not found in $ROOT — run this from the fork checkout"
[ -f patches/meta.json ] || die "patches/meta.json missing — the kit looks incomplete"

# ── preflight ─────────────────────────────────────────────────────────

if [ "$FORCE" -eq 0 ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "working tree has uncommitted changes to tracked files.
       Commit or stash them first, or pass --force."
fi

if [ "$FORCE" -eq 0 ] && git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  die "branch $BRANCH already exists. Delete it, or pass --force to reset it."
fi

# ── locate the upstream remote ────────────────────────────────────────

if [ -z "$REMOTE" ]; then
  # Prefer a remote actually named "upstream"; otherwise any opentui
  # remote that isn't the fork itself. The upstream repo has moved
  # org more than once, so don't hard-code the owner.
  FORK_URL="$(node -e '
    const fs = require("fs");
    const meta = JSON.parse(fs.readFileSync("patches/meta.json", "utf8"));
    process.stdout.write(meta.fork ?? "");
  ')"
  if git remote get-url upstream >/dev/null 2>&1; then
    REMOTE=upstream
  else
    for candidate in $(git remote); do
      url="$(git remote get-url "$candidate" 2>/dev/null || true)"
      case "$url" in
        *opentui*)
          [ "$url" = "$FORK_URL" ] && continue
          REMOTE="$candidate"; break ;;
      esac
    done
  fi
  [ -n "$REMOTE" ] && info "upstream remote: $REMOTE ($(git remote get-url "$REMOTE"))"
fi

if [ "$NO_FETCH" -eq 0 ]; then
  if [ -n "$REMOTE" ]; then
    info "fetching tags from $REMOTE"
    git fetch --tags "$REMOTE" || warn "fetch failed — continuing with local tags"
  else
    warn "no upstream remote found; using local tags only.
       Add one with: git remote add upstream <upstream-url>"
  fi
fi

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || die "tag $TAG not found. Available:
$(git tag --list 'v*' | "$SORT" -V | tail -8 | command sed 's/^/         /')"

# ── snapshot the kit before we leave this branch ──────────────────────
#
# The new branch is created from an upstream tag, which knows nothing
# about patches/ — so the kit has to travel out-of-tree and come back.
# This is also what propagates the kit onto the new branch.

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/xin-kit.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT INT TERM

mkdir -p "$STAGE/scripts"
cp -R patches "$STAGE/patches"
for s in xin-patch.sh xin-regen.sh; do
  [ -f "scripts/$s" ] && cp -p "scripts/$s" "$STAGE/scripts/$s"
done
info "kit staged at $STAGE"

# ── branch from the upstream tag ──────────────────────────────────────

info "creating $BRANCH from $TAG"
if [ "$FORCE" -eq 1 ]; then
  git checkout -q -B "$BRANCH" "$TAG"
else
  git checkout -q -b "$BRANCH" "$TAG"
fi
ok "on $BRANCH at $(git rev-parse --short HEAD)"

# ── restore the kit ───────────────────────────────────────────────────

rm -rf patches
cp -R "$STAGE/patches" patches
mkdir -p scripts
for s in xin-patch.sh xin-regen.sh; do
  [ -f "$STAGE/scripts/$s" ] && cp -p "$STAGE/scripts/$s" "scripts/$s"
done
ok "kit restored"

# ── disable upstream CI ───────────────────────────────────────────────
#
# Upstream's workflows assume upstream's secrets, runners and release
# process. Left active they fire on every push to the fork and fail
# noisily. Moving rather than deleting keeps them readable and keeps the
# step mechanical, so it works on any upstream version regardless of
# which workflows exist that release.

if [ -d .github/workflows ]; then
  mkdir -p .github/disabled-workflows
  moved=0
  for f in .github/workflows/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    case "$base" in xin-*) continue ;; esac
    git mv -f "$f" ".github/disabled-workflows/$base" 2>/dev/null || mv -f "$f" ".github/disabled-workflows/$base"
    moved=$((moved + 1))
  done
  ok "disabled $moved upstream workflow(s)"
fi

# ── lay down additive files ───────────────────────────────────────────

info "copying additive files"
added=0
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  mkdir -p "$(dirname "$rel")"
  cp -p "patches/add/$rel" "$rel"
  added=$((added + 1))
done < <(cd patches/add && "$FIND" . -type f | command sed 's|^\./||' | "$SORT")
ok "$added file(s) copied"

# ── apply modifications ───────────────────────────────────────────────

info "applying patches to upstream files"
CONFLICTS=()
APPLIED=0
while IFS= read -r p; do
  [ -n "$p" ] || continue
  target="${p#patches/mod/}"; target="${target%.patch}"
  # -3 falls back to a three-way merge using the blob hashes recorded in
  # the patch, which is what lets a diff generated against an older
  # upstream tag still apply after upstream edits the same file.
  if git apply -3 --whitespace=nowarn "$p" 2>"$STAGE/apply.err"; then
    if git diff --name-only --diff-filter=U | "$GREP" -qxF "$target"; then
      printf '  \033[33mCONFLICT\033[0m %s\n' "$target"
      CONFLICTS+=("$target")
    else
      ok "$target"
      APPLIED=$((APPLIED + 1))
    fi
  else
    if "$GREP" -q 'with conflicts' "$STAGE/apply.err"; then
      printf '  \033[33mCONFLICT\033[0m %s\n' "$target"
      CONFLICTS+=("$target")
    else
      printf '  \033[31mFAILED\033[0m   %s\n' "$target"
      command sed 's/^/           /' "$STAGE/apply.err" >&2
      CONFLICTS+=("$target")
    fi
  fi
done < <("$FIND" patches/mod -name '*.patch' -type f | "$SORT")

# ── package.json transform ────────────────────────────────────────────

info "transforming package.json files"
node patches/apply-package-json.mjs

# ── record the base ───────────────────────────────────────────────────

node -e '
  const fs = require("fs");
  const meta = JSON.parse(fs.readFileSync("patches/meta.json", "utf8"));
  meta.appliedTo = { version: process.argv[1], tag: process.argv[2] };
  fs.writeFileSync("patches/meta.json", JSON.stringify(meta, null, 2) + "\n");
' "$VERSION" "$TAG"

# ── is this version still free on npm? ────────────────────────────────

if [ "$SKIP_NPM" -eq 0 ] && command -v npm >/dev/null 2>&1; then
  info "checking npm (versions are immutable — a burned one cannot be reused)"
  BURNED=()
  for name in core react solid keymap core-android-arm64; do
    if npm view "@androidtui/$name@$VERSION" version >/dev/null 2>&1; then
      printf '  \033[31mtaken\033[0m @androidtui/%s@%s\n' "$name" "$VERSION"
      BURNED+=("$name")
    else
      ok "@androidtui/$name@$VERSION is free"
    fi
  done
fi

# ── report ────────────────────────────────────────────────────────────

echo
printf '\033[1m═══ %s → %s ═══\033[0m\n' "$TAG" "$BRANCH"
echo
printf '  applied cleanly   %s/%s\n' "$APPLIED" "$(( APPLIED + ${#CONFLICTS[@]} ))"
printf '  additive files    %s\n' "$added"

if [ "${#CONFLICTS[@]}" -gt 0 ]; then
  echo
  printf '\033[33m  %s file(s) need hand-merging:\033[0m\n' "${#CONFLICTS[@]}"
  for c in "${CONFLICTS[@]}"; do printf '    %s\n' "$c"; done
  echo
  echo "  Open each one and search for <<<<<<< markers. Upstream's side is"
  echo "  labelled 'ours'; the fork's side is 'theirs'. Fork additions are"
  echo "  tagged with an ANDROIDTUI comment — keep those, and keep whatever"
  echo "  upstream added around them."
fi

if [ "${BURNED[*]:-}" != "" ]; then
  echo
  printf '\033[31m  %s package(s) already published at %s.\033[0m\n' "${#BURNED[@]}" "$VERSION"
  echo "  npm will reject a republish. Pick a different version, or bump"
  echo "  the four package.json versions before tagging."
fi

cat <<EOF

  Next:
    bun install
    bash packages/core/scripts/build-native-termux.sh
    bash scripts/xin-regen.sh
    git add -A && git commit -m "port ANDROIDTUI Android patches to $TAG"
    git tag xin-v$VERSION && git push origin "$BRANCH" xin-v$VERSION

EOF
