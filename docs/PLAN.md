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
| Vault crypto, item model, sync client | `packages/core` | TypeScript, `hash-wasm` (Argon2id), `@noble/ciphers` (XChaCha20-Poly1305). No Node or DOM specifics: the desktop and Android apps both use it. |
| App logic shared by every client | `packages/app` | The UI-to-platform contract (`contract.ts`) and `VaultService`: unlock, edit, save, sync. Platform specifics (storage, OS credential store, SSH key handling) are injected as a `Platform`. |
| Shared interface | `packages/ui` | React screens and terminal, used by desktop and mobile. Talks only to `window.termterm` (the contract). |
| Sync server | `apps/server` | Node 22 `node:http` + `node:sqlite`, zero runtime dependencies, Docker image. |
| Android app | `apps/mobile` | Capacitor shell around `packages/ui`. `src/api.ts` implements the contract in the WebView on top of `VaultService`; storage is Capacitor Filesystem in the app's private directory. The native project is in `apps/mobile/android` (committed). Unlike desktop, the unlocked vault lives in the same process as the interface, so the app must never load remote content. |
| Desktop app | `apps/desktop` | Electron shell: implements the contract over IPC, with `ssh2` for SSH and Electron `safeStorage` for the device key. |

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
- **On desktop, secrets stay in the Electron main process.** The renderer is
  sandboxed (`contextIsolation`, `sandbox`, CSP, no navigation) and only
  receives redacted items (`hasPassword`, public keys). SSH connections are
  made in main. On Android there is one process, so the same separation is
  kept by convention only: the interface still talks to the vault solely
  through the contract.
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

## What has been verified, and how

Automated, on every relevant change (see `.github/workflows/build.yml`):

- `npm test`: 23 unit and integration tests for the vault, sync and server.
- `npm run e2e`: two desktop app instances against a throwaway SSH server and
  sync server (vault, keys, hosts, sync, password and key logins, password
  change, remote sign-out, turning sync off and signing back in, lock with
  sessions surviving, launch from the credential store, updater against a fake
  feed, changed host key refused).
- `npm run e2e:mobile`: the mobile app's web layer in a phone-sized browser.
- `npm run test:ssh -w @termterm/mobile`: the Android SSH core on a JVM
  against a throwaway SSH server.
- The server image is started on a root-owned bind mount and health-checked.
- The Windows installer and the Android debug APK are built.

Confirmed in real use by the project owner:

- Windows: installing from a release; syncing over HTTPS through a Cloudflare
  tunnel.
- Sync server: running from the published image on Unraid.
- Android (on a phone): vault, sign-in and sync, including to a plain-http
  server on the local network.
- The Release and Cleanup workflows have each run successfully.

Not yet confirmed anywhere:

- Android SSH sessions, the extra key row and on-screen keyboard behaviour on
  a real device (added after the last device test).
- A signed release APK (needs the signing key secrets, then a release).
- The Windows in-app update from one release to the next.
- "Open unlocked on this device" against a real OS credential store.
- Anything on macOS.

Known gaps inside phase 1 scope:

- Signing an open vault in to an existing account (`Vault.joinAccount`) keeps
  local items, but items deleted on that device while sync was off come back
  from the account, because tombstones are not kept without sync.
- If the app dies between the server accepting a password change and the local
  vault file being rewritten, this device still unlocks with the old password
  while the account uses the new one. Recovery path: none yet (needs a retry
  journal).
- `ssh2` occasionally generates an Ed25519 key its own parser rejects;
  `apps/desktop/src/main/keys.ts` retries until the key parses.

## Suggested order from here

1. Try Android SSH on a device and fix what that turns up.
2. Add the Android signing key secrets and cut a release, to get the first
   signed APK; confirm the Windows update button at the same time.
3. Android step 4: keep sessions alive in the background, fingerprint unlock,
   a proper icon.
4. Account deletion from the app.
5. Desktop terminal features, starting with split panes (phase 3).

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
- [ ] Account deletion from the app (today it takes a database command on the server; see the README), server-side storage quota reporting, server backups doc

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

- [x] CI (`build.yml`): typecheck and unit tests always; the desktop e2e, Windows installer and server image jobs run only when that app or shared code changed (`.github/scripts/changed-areas.sh`); pushes to `main` that touch the server publish its image as `edge`
- [x] Releases (`release.yml`): one version from a tag or a manual run stamps the app, publishes Windows + Linux installers on a GitHub release, and pushes the multi-arch server image to ghcr.io (`X.Y.Z`, `X.Y`, `latest`)
- [x] In-app updates with electron-updater from GitHub releases (Settings → About, plus an Update button in the top bar); version shown in the sidebar and About
- [x] Storage cleanup (`cleanup.yml` + `.github/scripts/cleanup.sh`): prunes artifacts, run logs, caches, old releases and old image versions, keeping the newest 3. Has run for real after a release.
- [x] First real releases made; the Release workflow works end to end
- [ ] Confirm on Windows that an installed older version updates itself from the Update button (the updater is otherwise tested only against a fake feed on Linux)
- [ ] Code signing for the Windows installer; macOS build (needs signing and notarisation before it can self-update)
- [ ] Android app (`apps/mobile`, Capacitor) reusing `packages/core`, `packages/app` and `packages/ui`:
  - [x] Step 1: shared UI and vault logic moved out of the desktop app into `packages/ui` and `packages/app`
  - [x] Step 2: Android app with vault and sync (no SSH yet). The web layer is
        covered by `npm run e2e:mobile` in a phone-sized browser (vault, storage,
        cross-origin sync between two profiles), and it has been used on a real
        phone. The sync server sends CORS headers for it, and the app accepts a
        plain-http server on the local network. Still to do: an emulator test in
        CI.
  - [x] Step 3: native SSH plugin and the terminal. The SSH core
        (`apps/mobile/android/app/src/main/java/dev/termterm/app/ssh`, plain Java
        on JSch) is tested on a JVM by `npm run test:ssh -w @termterm/mobile`.
        `SshPlugin.java` bridges it to the WebView and `apps/mobile/src/ssh.ts`
        makes the vault decisions (credentials, host key trust), mirroring the
        desktop. Includes the extra key row and keyboard-aware sizing.
        **The plugin bridge, the on-screen keyboard behaviour and the terminal
        have not been run on a device.**
  - [ ] Step 4: biometric unlock (Android Keystore), background sessions (foreground service), app icon and splash screen
  - [x] Step 5: signed `termterm-<version>.apk` on each release, when the signing key secrets are set (README, "Android signing key"). **Not yet exercised: needs the secrets and a real release.**
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
