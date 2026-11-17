#!/usr/bin/env bash
# Tests release-version.sh: what it accepts, how it tidies it, what it refuses.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
failed=0

accepts() { # input expected
  local got
  if ! got="$("$here/release-version.sh" "$1" 2>/dev/null)" || [ "$got" != "$2" ]; then
    echo "FAIL: \"$1\" should give \"$2\", got \"${got:-<refused>}\""
    failed=1
  fi
}
refuses() { # input
  if "$here/release-version.sh" "$1" >/dev/null 2>&1; then
    echo "FAIL: \"$1\" should be refused"
    failed=1
  fi
}

accepts '1.2.3' '1.2.3'
accepts 'v0.10.0' '0.10.0'
accepts '  v1.2.3 ' '1.2.3'
accepts $'1.2.3\n' '1.2.3'
accepts '10.20.30' '10.20.30'
accepts '0.0.0' '0.0.0'
accepts '1.2.3-beta.1' '1.2.3-beta.1'
accepts '1.2.3-rc.0' '1.2.3-rc.0'
accepts '1.2.3-x-y.0a' '1.2.3-x-y.0a'
accepts '1.2.3-alpha' '1.2.3-alpha'

refuses ''
refuses 'v'
refuses '1.2'
refuses '1.2.3.4'
refuses '01.2.3'
refuses '1.02.3'
refuses '1.2.03'
refuses '1. 2.3'
refuses '1.2.3 beta'
refuses 'vv1.2.3'
refuses '1.2.3-'
refuses '1.2.3-beta..1'
refuses '1.2.3-01'
refuses '1.2.3-beta_1'
refuses '1.2.3+build'
refuses '-1.2.3'
refuses $'1.2.3\nnot a version'
refuses $'nonsense\n1.2.3'

if [ "$failed" = 0 ]; then echo "release-version.sh: all cases pass"; fi
exit "$failed"
