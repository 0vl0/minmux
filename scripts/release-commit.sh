#!/usr/bin/env bash
# Bump the version, write its CHANGELOG.md entry, commit "release: vX.Y.Z" and tag it.
# Used by `make release` and the Release workflow's bump job; prints the tag on stdout.
# Usage: scripts/release-commit.sh patch|minor|major
set -euo pipefail

bump="${1:?usage: release-commit.sh patch|minor|major}"
cd "$(git rev-parse --show-toplevel)"
files=(package.json package-lock.json CHANGELOG.md)

# Refuse a dirty tree: with --no-git-tag-version, npm version no longer checks it.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "release-commit: the working tree has changes; commit or stash them first" >&2
  exit 1
fi

# Until the tag exists, any exit (an error, Ctrl-C) undoes the release commit and the bump,
# so a rerun bumps from the same version.
start="$(git rev-parse HEAD)"
done=0
undo() {
  [ "$done" = 1 ] && return
  git reset -q --soft "$start"
  git checkout -q HEAD -- "${files[@]}"
  echo "release-commit: failed; package.json and CHANGELOG.md are back as they were" >&2
}
trap undo EXIT
trap 'exit 130' INT TERM

npm version "$bump" --no-git-tag-version >&2
tag="v$(node -p "require('./package.json').version")"
if git rev-parse -q --verify "refs/tags/$tag" > /dev/null; then
  echo "release-commit: tag $tag already exists (delete it if it's left from a failed attempt)" >&2
  exit 1
fi
make -s changelog TAG="$tag" >&2
git commit -q -m "release: $tag" -- "${files[@]}" >&2
git tag -a "$tag" -m "release: $tag"
done=1
echo "$tag"
