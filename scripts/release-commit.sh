#!/usr/bin/env bash
# Bump the version, write its CHANGELOG.md entry, commit "release: vX.Y.Z" and tag it.
# Used by `make release` and the Release workflow's bump job; prints the tag on stdout.
# Usage: scripts/release-commit.sh patch|minor|major
set -euo pipefail

bump="${1:?usage: release-commit.sh patch|minor|major}"
files=(package.json package-lock.json CHANGELOG.md)

# Refuse a dirty tree: with --no-git-tag-version, npm version no longer checks it.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "release-commit: the working tree has changes; commit or stash them first" >&2
  exit 1
fi

# Anything failing after the bump puts the three files back, so a rerun bumps from the same version.
trap 'git checkout -- "${files[@]}" 2>/dev/null || true' ERR

npm version "$bump" --no-git-tag-version >&2
tag="v$(node -p "require('./package.json').version")"
make -s changelog TAG="$tag" >&2
git commit -m "release: $tag" -- "${files[@]}" >&2
trap - ERR
git tag -a "$tag" -m "release: $tag"
echo "$tag"
