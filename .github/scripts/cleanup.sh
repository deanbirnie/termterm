#!/usr/bin/env bash
# Storage cleanup for this repository, run by .github/workflows/cleanup.yml.
#
#   cleanup.sh artifacts   keep the newest few build artifacts of each kind
#   cleanup.sh runs        delete old workflow runs and their logs
#   cleanup.sh caches      delete caches left by closed pull requests or unused for a week
#   cleanup.sh releases    keep the newest few releases (git tags are kept)
#
# Needs GH_TOKEN and GH_REPO. With DRY_RUN=true it only prints what it would do.
set -euo pipefail

KEEP_ARTIFACTS="${KEEP_ARTIFACTS:-3}"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
RUN_LOG_DAYS="${RUN_LOG_DAYS:-30}"
CACHE_IDLE_DAYS="${CACHE_IDLE_DAYS:-7}"
DRY_RUN="${DRY_RUN:-false}"

act() {
  if [ "$DRY_RUN" = "true" ]; then
    echo "  would run: $*"
  else
    "$@"
  fi
}

days_ago() { date -u -d "$1 days ago" +%Y-%m-%dT%H:%M:%SZ; }
hours_ago() { date -u -d "$1 hours ago" +%Y-%m-%dT%H:%M:%SZ; }

artifacts() {
  # Release staging artifacts ("release-*") are copies of what is already
  # attached to the release, so none are kept once they are an hour old (a
  # release still in progress may be using younger ones). Of everything else,
  # the newest $KEEP_ARTIFACTS of each name are kept.
  local staging_cutoff
  staging_cutoff="$(hours_ago 1)"
  gh api --paginate "repos/$GH_REPO/actions/artifacts?per_page=100" \
    --jq '.artifacts[] | select(.expired | not) | [.name, .created_at, .id, .size_in_bytes] | @tsv' |
    sort -t "$(printf '\t')" -k1,1 -k2,2r |
    awk -F '\t' -v keep="$KEEP_ARTIFACTS" -v cutoff="$staging_cutoff" '
      { seen[$1]++ }
      $1 ~ /^release-/ { if ($2 < cutoff) print; next }
      seen[$1] > keep { print }
    ' |
    while IFS="$(printf '\t')" read -r name created id size; do
      echo "artifact $name from $created ($((size / 1048576)) MB)"
      act gh api -X DELETE "repos/$GH_REPO/actions/artifacts/$id"
    done
}

runs() {
  local cutoff
  cutoff="$(days_ago "$RUN_LOG_DAYS")"
  gh api --paginate "repos/$GH_REPO/actions/runs?per_page=100&status=completed&created=%3C$cutoff" \
    --jq '.workflow_runs[] | [.id, .name, .created_at] | @tsv' |
    while IFS="$(printf '\t')" read -r id name created; do
      echo "run $id ($name) from $created"
      act gh api -X DELETE "repos/$GH_REPO/actions/runs/$id"
    done
}

caches() {
  local cutoff
  cutoff="$(days_ago "$CACHE_IDLE_DAYS")"
  gh api --paginate "repos/$GH_REPO/actions/caches?per_page=100" \
    --jq '.actions_caches[] | [.id, .ref, .last_accessed_at, .size_in_bytes] | @tsv' |
    awk -F '\t' -v cutoff="$cutoff" '$2 ~ /^refs\/pull\// || $3 < cutoff' |
    while IFS="$(printf '\t')" read -r id ref accessed size; do
      echo "cache $id for $ref, last used $accessed ($((size / 1048576)) MB)"
      act gh api -X DELETE "repos/$GH_REPO/actions/caches/$id"
    done
}

releases() {
  # Newest first. The release marked "latest" is never removed, whatever its
  # position, because installed apps update from it. Tags stay, so any old
  # version can be rebuilt from source.
  local latest
  latest="$(gh api "repos/$GH_REPO/releases/latest" --jq .tag_name 2>/dev/null || true)"
  gh api --paginate "repos/$GH_REPO/releases?per_page=100" \
    --jq '.[] | select(.draft | not) | [.created_at, .id, .tag_name] | @tsv' |
    sort -r |
    awk -F '\t' -v keep="$KEEP_RELEASES" -v latest="$latest" 'NR > keep && $3 != latest' |
    while IFS="$(printf '\t')" read -r created id tag; do
      echo "release $tag from $created"
      act gh api -X DELETE "repos/$GH_REPO/releases/$id"
    done
}

case "${1:-}" in
  artifacts | runs | caches | releases) "$1" ;;
  *)
    echo "usage: $0 artifacts|runs|caches|releases" >&2
    exit 2
    ;;
esac
