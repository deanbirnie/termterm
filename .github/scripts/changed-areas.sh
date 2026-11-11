#!/usr/bin/env bash
# Works out which parts of the repository a push or pull request touches, so
# CI only builds the apps that could be affected. Prints `name=true|false`
# lines for $GITHUB_OUTPUT.
#
#   changed-areas.sh <base-commit>      (empty or unknown base = everything)
set -euo pipefail

base="${1:-}"
all=false
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  all=true
  files=""
else
  files="$(git diff --name-only "$base"...HEAD)"
fi

touched() {
  [ "$all" = true ] && return 0
  printf '%s\n' "$files" | grep -Eq "$1"
}

# Code every app is built from, plus the build configuration itself.
shared='^(packages/|package\.json$|package-lock\.json$|tsconfig\.base\.json$|\.github/workflows/build\.yml$|\.github/scripts/changed-areas\.sh$)'

area() {
  if touched "$shared" || touched "$2"; then echo "$1=true"; else echo "$1=false"; fi
}

area desktop '^apps/desktop/'
area mobile '^apps/mobile/'
area server '^(apps/server/|docker-compose\.yml$)'
