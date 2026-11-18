#!/usr/bin/env bash
# Checks a built APK before it is published:
#
#   check-apk.sh <apk> <versionName> [<certificate SHA-256>]
#
# - its signature verifies (apksigner);
# - its versionName is the release's, and its versionCode is the one
#   build.gradle derives from it (major*1000000 + minor*1000 + patch), so it
#   installs over the previous release;
# - with a certificate given, it is signed by that certificate. Android only
#   installs an update signed with the same key as the installed app.
#
# Uses the Android SDK's build tools (on GitHub's runners: $ANDROID_HOME).
set -euo pipefail

apk="${1:?usage: check-apk.sh <apk> <versionName> [<cert sha256>]}"
version_name="${2:?usage: check-apk.sh <apk> <versionName> [<cert sha256>]}"
want_cert="$(printf '%s' "${3-}" | tr -d ': \n' | tr '[:upper:]' '[:lower:]')"

# The SDK's newest build tools, or (for test-check-apk.sh) the folder in CHECK_APK_TOOLS.
tools="${CHECK_APK_TOOLS:-}"
if [ -z "$tools" ]; then
  sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  tools="$(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)"
fi
if [ -z "$tools" ] || [ ! -x "$tools/apksigner" ] || [ ! -x "$tools/aapt2" ]; then
  echo "::error::Android build tools (apksigner, aapt2) not found under \$ANDROID_HOME/build-tools"
  exit 1
fi

certs="$("$tools/apksigner" verify --print-certs "$apk")" || {
  echo "::error::$apk: signature does not verify"
  exit 1
}
echo "signature verifies"

if [ -n "$want_cert" ]; then
  # apksigner names signers "Signer #1", "Signer (minSdkVersion=..., ...)"
  # when the signature schemes differ by Android version, or "V2 Signer:" by
  # scheme, depending on its version: read every one. (Not a "Source Stamp"
  # signer, which is not the app's own certificate.)
  got="$(printf '%s\n' "$certs" | sed -n 's/^\(V[0-9.]* \)\{0,1\}Signer[^:]*:\{0,1\} certificate SHA-256 digest: //p' | tr -d ': ' | tr '[:upper:]' '[:lower:]' | sort -u)"
  if [ -z "$got" ]; then
    echo "::error::Could not read the signing certificate of $apk. apksigner said:"
    printf '%s\n' "$certs"
    exit 1
  fi
  if [ "$got" != "$want_cert" ]; then
    echo "::error::$apk is signed by $(printf '%s' "$got" | tr '\n' ' ')not the release certificate $want_cert. It would not install over the app."
    exit 1
  fi
  echo "signed by the release certificate"
fi

badging="$("$tools/aapt2" dump badging "$apk" | head -n 1)"
got_name="$(printf '%s' "$badging" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
got_code="$(printf '%s' "$badging" | sed -n "s/.*versionCode='\([^']*\)'.*/\1/p")"
IFS=. read -r major minor patch <<< "${version_name%%-*}"
want_code=$((major * 1000000 + minor * 1000 + patch))
if [ "$got_name" != "$version_name" ] || [ "$got_code" != "$want_code" ]; then
  echo "::error::$apk is version $got_name ($got_code), expected $version_name ($want_code)"
  exit 1
fi
echo "version $got_name, code $got_code"
