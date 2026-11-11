# termterm — phased plan

A cross-device SSH client whose hosts, keys and credentials live in an
end-to-end encrypted vault that syncs through a small self-hosted server.
This file is the hand-over document: it records what exists, what is next,
and the decisions already made so work can resume in a fresh session.

**Update the status boxes in this file whenever a phase item lands.**

Routine upkeep (dependency, security and deprecation checks) has its own
procedure in [MAINTENANCE.md](MAINTENANCE.md).

## Architecture (decided)

| Piece | Location | Stack |
|---|---|---|
| Vault crypto, item model, sync client | `packages/core` | TypeScript, `hash-wasm` (Argon2id), `@noble/ciphers` (XChaCha20-Poly1305). No Node or DOM specifics, so it can be reused by a future mobile app or CLI. |
| Sync server | `apps/server` | Node 22 `node:http` + `node:sqlite`, zero runtime dependencies, Docker image. |
| Desktop app | `apps/desktop` | Electron, electron-vite, React, xterm.js, `ssh2`. |

Decisions worth knowing before changing things:

- **Zero-knowledge sync.** The master password never leaves the device.
  Argon2id(password, salt) → master key → HKDF → `wrapKey` (encrypts the random
  vault key) and `authKey` (sent to the server, which scrypt-hashes it). Every
  item is sealed separately with the vault key, with its id as associated data.
  The server stores only ciphertext; it cannot even see item types. See
  `packages/core/src/crypto.ts` and the "Security model" section of the README.
- **Sync protocol.** Per-account monotonically increasing `seq`. Clients pull
  `seq > cursor`, then push dirty items with the `baseSeq` they were edited on.
  A mismatch is a conflict; the client resolves last-writer-wins using the
  `updatedAt` inside the ciphertext and retries. Deletes are encrypted
  tombstones. See `packages/core/src/sync.ts` and `vault.ts#applyRemote`.
- **Secrets stay in the Electron main process.** The renderer is sandboxed
  (`contextIsolation`, `sandbox`, CSP, no navigation) and only receives redacted
  items (`hasPassword`, public keys). SSH connections are made in main.
- **Host keys are verified** trust-on-first-use, stored as `knownHost` vault
  items (so they sync too); a changed key blocks the connection with a warning.
- Item types today: `host`, `key`, `snippet`, `knownHost`
  (`packages/core/src/types.ts`). Adding a type needs no server change.

## Phase 1 — Secure vault + sync (the priority)

- [x] Crypto core: KDF, key hierarchy, sealed boxes (`packages/core`)
- [x] Vault: create / unlock / lock, encrypted item CRUD, tombstones
- [x] Sync client: pull, push, conflict resolution
- [x] Sync server: register, prelogin, login, logout, pull, push, throttling, limits
- [x] Unit + integration tests (`npm test`)
- [x] Desktop: onboarding (create vault / sign in on a new device), unlock, lock
- [x] Desktop: hosts, keychain (generate + import), known hosts, snippets UI
- [x] Desktop: sync settings (create account, sign in, status, sync now, disconnect), auto-sync
- [x] Desktop: SSH terminal sessions in tabs (password, key, keyboard-interactive auth)
- [x] End-to-end smoke test driving the real app against a test SSH server

Verified so far: `npm test` (20 tests) and `npm run e2e` (two app instances:
create vault, generate key, save host, register sync, password and public-key
logins, second-device sign-in, edit propagation, master password change across both
devices, remote sign-out, lock/unlock with sessions surviving, launching
unlocked from the credential store, changed host key refused). The sync server Docker image builds and passes its health check, and a
packaged Linux build of the app starts and works. **Not yet verified by hand:**
the app on Windows and macOS. The Windows installer is built by
`.github/workflows/build.yml` on a Windows runner (it cannot be built on Linux
without Wine); check that run's result before relying on it.

Known gaps inside phase 1 scope:

- An existing local vault cannot join an existing sync account (only a fresh
  device can sign in). Merging two vaults needs a re-key step.
- If the app dies between the server accepting a password change and the local
  vault file being rewritten, this device still unlocks with the old password
  while the account uses the new one. Recovery path: none yet (needs a retry
  journal).
- `ssh2` occasionally generates an Ed25519 key its own parser rejects;
  `apps/desktop/src/main/keys.ts` retries until the key parses.

## Phase 2 — Vault hardening and account management

- [x] Change master password: re-wraps the vault key and rotates `authKey` via `POST /v1/password`, which signs out other devices; they adopt the new keys on "Sign in again" (`Vault.adoptAccountKeys`)
- [x] "Open unlocked on this device": the vault key is kept in the OS credential
      store via Electron `safeStorage` (async API) and used at launch. A manual or
      automatic lock deletes it, so a restart cannot undo a lock. Refused on Linux
      without a real keyring. Tested in e2e with a stand-in store
      (`TERMTERM_INSECURE_KEYSTORE=1`, tests only); **not yet run against real
      DPAPI / Keychain / libsecret.**
- [ ] Optional biometric gate (Windows Hello / Touch ID) in front of the stored key
- [x] Auto-lock after system idle time and on sleep / screen lock (device-local `settings.json`, default 15 minutes). The idle timer itself has no automated test.
- [x] Locking keeps established SSH sessions running (hidden until unlock)
- [x] Device list and remote sign-out (`/v1/sessions*`); device names are sealed with the vault key so the server cannot read them
- [ ] Rollback protection: sign a per-device view of the highest seen `seq`
      so a malicious server cannot silently serve stale data
- [ ] Encrypted export / import (and import from `~/.ssh/config`, `known_hosts`)
- [ ] Identities (reusable username + credential shared across hosts), host groups
- [ ] SSH certificates, FIDO2 / security-key keys, agent forwarding
- [ ] Account deletion, server-side storage quota reporting, server backups doc

## Phase 3 — Terminal and session features

- [ ] Split panes / tiling of sessions inside a tab
- [ ] Local terminal tab (`node-pty`)
- [ ] Reconnect, keep-alive settings, per-host startup snippet, env vars
- [ ] Host chaining (jump hosts / ProxyJump), SOCKS/HTTP proxy
- [ ] Port forwarding (local, remote, dynamic) as vault items
- [ ] SFTP browser (dual pane, drag and drop)
- [ ] Terminal themes, fonts, per-host colour; search in scrollback; session logs
- [ ] Predictive typing / autocomplete (command history + snippets), broadcast input
- [ ] Mosh, Telnet, serial

## Phase 4 — Distribution and more devices

- [x] CI (`build.yml`): typecheck, tests, e2e, server image check, Windows installer artifact; pushes to `main` publish the server image as `edge`
- [x] Releases (`release.yml`): one version from a tag or a manual run stamps the app, publishes Windows + Linux installers on a GitHub release, and pushes the multi-arch server image to ghcr.io (`X.Y.Z`, `X.Y`, `latest`)
- [x] In-app updates with electron-updater from GitHub releases (Settings → About, plus an Update button in the top bar); version shown in the sidebar and About
- [ ] **Run the first real release** and confirm on Windows that an installed older version updates itself. Until then the release workflow and the Windows update path are unproven (the updater is tested against a fake feed on Linux only)
- [ ] Code signing for the Windows installer; macOS build (needs signing and notarisation before it can self-update)
- [ ] Mobile app (React Native or Capacitor) reusing `packages/core`
- [ ] Shared vaults / teams (per-vault keys wrapped to each member's public key)

## Working on the repo

```bash
npm install
npm test            # core + server tests
npm run typecheck
npm run dev         # desktop app with hot reload
npm run server      # sync server on :8787
npm run e2e         # desktop smoke test (needs a display; use xvfb-run on Linux)
```
