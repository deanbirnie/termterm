#!/usr/bin/env bash
# Checks the server image's backup and restore, end to end: an account with an
# item on a running container, a backup taken while it runs (backup.ts), then
# a fresh container started from only that backup, which must still have the
# account and the item.
#
#   check-backup-restore.sh <image>
set -euo pipefail

image="${1:?usage: check-backup-restore.sh <image>}"
work="$(mktemp -d)"
port=18787
cleanup() {
  docker rm -f termterm-backup-a termterm-backup-b >/dev/null 2>&1 || true
  # Files written by the container belong to its user; remove them from inside one.
  docker run --rm -v "$work:/w" --entrypoint sh "$image" -c 'rm -rf /w/*' >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

wait_healthy() {
  for _ in $(seq 1 30); do
    if curl -fs "http://127.0.0.1:$port/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs "$1"
  return 1
}

api() { # method path [json] [token]
  local args=(-fsS -X "$1" "http://127.0.0.1:$port/v1$2" -H 'content-type: application/json')
  if [ -n "${4:-}" ]; then args+=(-H "authorization: Bearer $4"); fi
  if [ -n "${3:-}" ]; then args+=(--data "$3"); fi
  curl "${args[@]}"
}

# Valid-looking key material: the server only checks shapes, not meaning.
salt="$(head -c 16 /dev/urandom | base64)"
auth_key="$(head -c 32 /dev/urandom | base64)"
wrapped="$(head -c 72 /dev/urandom | base64 | tr -d '\n')"
blob="$(head -c 96 /dev/urandom | base64 | tr -d '\n')"
kdf="{\"alg\":\"argon2id\",\"salt\":\"$salt\",\"m\":65536,\"t\":3,\"p\":1}"

mkdir -p "$work/a" "$work/b"
docker run -d --name termterm-backup-a -p "$port:8787" -e PUID=99 -e PGID=100 -v "$work/a:/data" "$image" >/dev/null
wait_healthy termterm-backup-a

token="$(api POST /register "{\"username\":\"backup-check\",\"kdf\":$kdf,\"authKey\":\"$auth_key\",\"wrappedVaultKey\":\"$wrapped\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')"
api POST /sync "{\"changes\":[{\"id\":\"item-1\",\"baseSeq\":0,\"blob\":\"$blob\"}]}" "$token" >/dev/null

docker exec termterm-backup-a node --disable-warning=ExperimentalWarning backup.ts /data/backups/check.db
test "$(stat -c %u "$work/a/backups/check.db")" = 99 || { echo "backup is not owned by the server's user"; exit 1; }
docker rm -f termterm-backup-a >/dev/null

# Restore: a new data folder holding only the backup, as termterm.db.
cp "$work/a/backups/check.db" "$work/b/termterm.db"
docker run -d --name termterm-backup-b -p "$port:8787" -e PUID=99 -e PGID=100 -v "$work/b:/data" "$image" >/dev/null
wait_healthy termterm-backup-b

token="$(api POST /login "{\"username\":\"backup-check\",\"authKey\":\"$auth_key\"}" | sed -E 's/.*"token":"([^"]+)".*/\1/')"
items="$(api GET '/sync?since=0' '' "$token")"
if ! printf '%s' "$items" | grep -q "\"blob\":\"$blob\""; then
  echo "the restored server is missing the item: $items"
  exit 1
fi
echo "backup taken from a running server, restored into a new container: account and item intact"
