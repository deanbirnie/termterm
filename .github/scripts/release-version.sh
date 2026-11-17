#!/usr/bin/env bash
# Turns what was typed or tagged into a release version, or refuses it.
#
#   release-version.sh " v1.2.3 "   ->  prints 1.2.3
#
# Forgives spaces around it (from typing or pasting) and a leading "v", but
# nothing inside it. The rest is semantic versioning: three numbers without
# leading zeros, and an optional pre-release of dot-separated parts that are
# not empty and, when numeric, have no leading zero (1.2.3-beta.1).
# Tested by test-release-version.sh.
set -euo pipefail

version="$(printf '%s' "${1-}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
version="${version#v}"
num='(0|[1-9][0-9]*)'
pre='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
if [[ "$version" == *$'\n'* ]] || ! printf '%s' "$version" | grep -Eq "^$num\.$num\.$num(-$pre(\.$pre)*)?\$"; then
  echo "::error::\"$version\" is not a version like 1.2.3 or 1.2.3-beta.1" >&2
  exit 1
fi
printf '%s\n' "$version"
