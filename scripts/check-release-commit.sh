#!/usr/bin/env bash
# The Release workflow's push job: checks the bump job's release commit before it reaches main,
# from a checkout of main. Prints `push_main=…` / `push_tag=…` (true when that push is still
# to do, so a re-run after a partial push finishes it).
# Usage: scripts/check-release-commit.sh vX.Y.Z release.bundle
set -euo pipefail

tag="${1:?usage: check-release-commit.sh vX.Y.Z release.bundle}"
bundle="${2:?usage: check-release-commit.sh vX.Y.Z release.bundle}"
fail() { echo "::error::$1" >&2; exit 1; }

[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "not a release tag: '$tag'"
ours="$(git bundle list-heads "$bundle" "refs/tags/$tag" | cut -d' ' -f1)"
[ -n "$ours" ] || fail "the bundle has no tag $tag"

# Is the tag on GitHub already? 0 = yes, 2 = no, anything else = couldn't tell.
rc=0
theirs="$(git ls-remote --exit-code --tags origin "refs/tags/$tag")" || rc=$?
case "$rc" in
  0) [ "${theirs%%[[:space:]]*}" = "$ours" ] || fail "tag $tag already exists on GitHub"
     push_tag=false ;;
  2) push_tag=true ;;
  *) fail "couldn't list GitHub's tags (git ls-remote exited $rc)" ;;
esac

git fetch -q "$bundle" "+refs/tags/$tag:refs/tags/$tag"
commit="$(git rev-parse "refs/tags/$tag^{commit}")"
read -r -a parents <<< "$(git rev-list --parents -n1 "$commit")"
[ "${#parents[@]}" = 2 ] || fail "the release commit must have exactly one parent"
base="${parents[1]}"
main="$(git rev-parse HEAD)"
if [ "$main" = "$commit" ]; then
  push_main=false # a previous attempt pushed main already
elif [ "$main" = "$base" ]; then
  push_main=true
else
  fail "the release commit isn't on main's tip (main moved during the run?)"
fi

changed="$(git diff --name-only "$base" "$commit" | sort | tr '\n' ' ')"
case "$changed" in
  "CHANGELOG.md package-lock.json package.json " | "package-lock.json package.json ") ;;
  *) fail "the release commit changes more than the version and the changelog: $changed" ;;
esac

# package.json and package-lock.json may differ in their version fields only, set to the tag's.
node - "$base" "$commit" "${tag#v}" <<'JS' || fail "package.json / package-lock.json change more than the version"
const { execFileSync } = require("node:child_process")
const [base, commit, version] = process.argv.slice(2)
const read = (rev, file) => JSON.parse(execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8" }))
const strip = (o, lock) => {
  const c = structuredClone(o)
  delete c.version
  if (lock && c.packages && c.packages[""]) delete c.packages[""].version
  return JSON.stringify(c)
}
const bad = (msg) => (console.error(msg), process.exit(1))
for (const [file, lock] of [["package.json", false], ["package-lock.json", true]]) {
  const before = read(base, file)
  const after = read(commit, file)
  if (strip(before, lock) !== strip(after, lock)) bad(`${file}: more than the version changed`)
  if (after.version !== version) bad(`${file}: version ${after.version}, the tag says ${version}`)
  if (lock && after.packages?.[""]?.version !== version) bad(`${file}: root package version`)
}
JS

echo "push_main=$push_main"
echo "push_tag=$push_tag"
