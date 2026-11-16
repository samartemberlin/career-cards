#!/usr/bin/env bash
# Publishes template/ to samartemberlin/career-cards-template with a pinned SHA.
# Usage: tools/publish-template.sh [--dry-run] <40-hex SHA>
#
# The placeholder 0000...0000 in the template workflows is replaced with the given SHA.
# SHA must be exactly 40 hex characters and must be on origin/main.
# --dry-run prints what would happen and exits without pushing.
set -euo pipefail

REPO="samartemberlin/career-cards-template"
PLACEHOLDER="0000000000000000000000000000000000000000"

dry_run=false
sha=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    *) sha="$arg" ;;
  esac
done

if [[ -z "$sha" ]]; then
  echo "usage: tools/publish-template.sh [--dry-run] <40-hex sha>" >&2
  exit 1
fi

if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: SHA must be exactly 40 lowercase hex characters, got: $sha" >&2
  exit 1
fi

# Validate the SHA is reachable from origin/main
if ! git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
  echo "error: $sha is not an ancestor of origin/main" >&2
  exit 1
fi

# Copy template/ into a temp dir and replace the placeholder
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

cp -r template/. "$tmpdir"
find "$tmpdir" -type f | xargs sed -i "s/$PLACEHOLDER/$sha/g"

if $dry_run; then
  echo "dry-run: would push template/ to $REPO with SHA $sha"
  echo "dry-run: files:"
  find "$tmpdir" -type f | sort | sed "s|$tmpdir/||"
  exit 0
fi

# Create the template repo if it doesn't exist
if ! gh repo view "$REPO" &>/dev/null; then
  echo "creating $REPO..."
  gh repo create "$REPO" --public
  gh api -X PATCH "repos/$REPO" -F is_template=true
fi

# Build a single commit and force-push to main
cd "$tmpdir"
git init -q
git config user.name "publish-template"
git config user.email "noreply@github.com"
git checkout -q -b main
git add .
git commit -q -m "template: pin career-cards to $sha"
git remote add origin "https://github.com/$REPO.git"
git push --force origin main
echo "pushed $sha to $REPO"
