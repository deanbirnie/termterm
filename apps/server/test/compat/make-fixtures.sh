#!/usr/bin/env bash
# Makes compatibility fixtures with a release's own code (see make-fixture.ts):
#
#   apps/server/test/compat/make-fixtures.sh v0.9.0 [v0.5.0 ...]
#
# Takes that release's core and server source from git, runs it with this
# checkout's dependencies, and writes fixtures/<tag>/. Commit the result.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
for tag in "$@"; do
  work="$here/.work/$tag"
  rm -rf "$work"
  mkdir -p "$work"
  git -C "$root" archive "$tag" packages/core/src apps/server/src | tar -x -C "$work"
  node --experimental-transform-types --disable-warning=ExperimentalWarning "$here/make-fixture.ts" "$work" "$here/fixtures/$tag" "$tag"
  rm -rf "$work"
done
