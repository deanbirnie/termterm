#!/usr/bin/env bash
# Tests check-apk.sh with stand-ins for apksigner and aapt2 that print what
# the real tools print, in the forms they have been seen to use.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tools="$(mktemp -d)"
trap 'rm -rf "$tools"' EXIT
cert=12d68394bf3c72cbd6190076d3b628e58c6611a60ad3b67b3bfd6303caae07d8
other=0000000000000000000000000000000000000000000000000000000000000000
failed=0

fake() { # <apksigner output file> <versionName> <versionCode>
  printf '#!/bin/sh\ncat "%s"\n' "$1" > "$tools/apksigner"
  printf "#!/bin/sh\necho \"package: name='dev.termterm.app' versionCode='%s' versionName='%s' platformBuildVersionName='16'\"\n" "$3" "$2" > "$tools/aapt2"
  chmod +x "$tools/apksigner" "$tools/aapt2"
}
expect() { # <name> <pass|fail> <args...>
  local name="$1" want="$2"; shift 2
  if CHECK_APK_TOOLS="$tools" "$here/check-apk.sh" "$@" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" != "$want" ]; then echo "FAIL: $name (expected $want)"; failed=1; fi
}

printf 'Signer #1 certificate DN: CN=termterm\nSigner #1 certificate SHA-256 digest: %s\nSigner #1 certificate SHA-1 digest: 1234\n' "$cert" > "$tools/numbered"
printf 'Signer (minSdkVersion=24, maxSdkVersion=2147483647) certificate DN: CN=termterm\nSigner (minSdkVersion=24, maxSdkVersion=2147483647) certificate SHA-256 digest: %s\n' "$cert" > "$tools/ranged"
printf 'Signer #1 certificate SHA-256 digest: %s\n' "$other" > "$tools/wrong"
printf 'Verifies\n' > "$tools/none"

fake "$tools/numbered" 0.11.0 11000
expect '"Signer #1" form, release certificate' pass x.apk 0.11.0 "$cert"
expect 'certificate given with colons and capitals' pass x.apk 0.11.0 "$(echo "$cert" | tr a-f A-F | sed 's/../&:/g; s/:$//')"
expect 'wrong version name' fail x.apk 0.12.0 "$cert"
fake "$tools/ranged" 0.11.0 11000
expect '"Signer (minSdkVersion=...)" form' pass x.apk 0.11.0 "$cert"
fake "$tools/wrong" 0.11.0 11000
expect 'another certificate' fail x.apk 0.11.0 "$cert"
expect 'no certificate check asked for (debug builds)' pass x.apk 0.11.0
fake "$tools/none" 0.11.0 11000
expect 'no certificate in the output' fail x.apk 0.11.0 "$cert"
fake "$tools/numbered" 0.11.0-debug 11000
expect 'debug suffix still gives the version code' pass x.apk 0.11.0-debug
fake "$tools/numbered" 0.11.0 11001
expect 'wrong version code' fail x.apk 0.11.0 "$cert"

if [ "$failed" = 0 ]; then echo "check-apk.sh: all cases pass"; fi
exit "$failed"
