#!/usr/bin/env bash
# Bump the version, write its CHANGELOG.md entry, commit "release: vX.Y.Z" and tag it; prints
# the tag. Run by the Release workflow's bump job on a fresh checkout of main (`make release`
# starts that workflow); the push job checks the commit and pushes it.
# Usage: scripts/release-commit.sh patch|minor|major
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
npm version "${1:?usage: release-commit.sh patch|minor|major}" --no-git-tag-version >&2
tag="v$(node -p "require('./package.json').version")"
make -s changelog TAG="$tag" >&2
git commit -q -m "release: $tag" -- package.json package-lock.json CHANGELOG.md >&2
git tag -a "$tag" -m "release: $tag"
echo "$tag"
