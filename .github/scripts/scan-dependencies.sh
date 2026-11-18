#!/usr/bin/env bash
# Scans what npm audit cannot see, with OSV-Scanner (https://osv.dev):
#
#   scan-dependencies.sh android <android project dir>
#       The Android app's Maven libraries (JSch, Bouncy Castle, AndroidX,
#       Capacitor), as Gradle resolves them for the release build. Needs the
#       Android SDK (as for building the APK).
#   scan-dependencies.sh image <local image name>
#       The sync server's container image, OS packages included.
#
# Fails on any known vulnerability. One that cannot be fixed yet is recorded
# in osv-scanner.toml at the repository root, with the reason and a date to
# look again (see docs/MAINTENANCE.md); past that date it fails again.
set -euo pipefail

VERSION=v2.7.0
SHA256=160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b # osv-scanner_linux_amd64

usage() {
  echo "usage: $0 android <android project dir> | image <image name>" >&2
  exit 2
}
[ $# -eq 2 ] || usage
what="$1"
target="$2"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The scanner, checked against the checksum pinned above before it runs.
curl -fsSL --retry 3 -o "$work/osv-scanner" \
  "https://github.com/google/osv-scanner/releases/download/$VERSION/osv-scanner_linux_amd64"
echo "$SHA256  $work/osv-scanner" | sha256sum --check --quiet
chmod +x "$work/osv-scanner"

config=()
[ -f "$root/osv-scanner.toml" ] && config=(--config "$root/osv-scanner.toml")

case "$what" in
  android)
    # Gradle writes the versions it resolves to a lockfile when locking is on;
    # an init script turns it on for this run only.
    cat > "$work/lock.gradle" <<'EOF'
allprojects { dependencyLocking { lockAllConfigurations() } }
EOF
    (cd "$target" && ./gradlew -q --init-script "$work/lock.gradle" :app:dependencies --write-locks > /dev/null)
    lock="$target/app/gradle.lockfile"
    test -s "$lock"
    # Only what ships in the app: test and build tooling resolve separately.
    mkdir -p "$work/release"
    grep -E '=(.*,)?releaseRuntimeClasspath(,|$)' "$lock" > "$work/release/gradle.lockfile"
    rm -f "$lock"
    echo "Android release libraries: $(wc -l < "$work/release/gradle.lockfile")"
    test -s "$work/release/gradle.lockfile"
    "$work/osv-scanner" scan source "${config[@]}" --lockfile "$work/release/gradle.lockfile"
    ;;
  image)
    "$work/osv-scanner" scan image "${config[@]}" "$target"
    ;;
  *)
    usage
    ;;
esac
