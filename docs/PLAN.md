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

- `npm test`: 89 unit and integration tests for the vault, sync, server, the shared app logic and the Windows Hello key store.
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
- Android fingerprint unlock, background sessions and the new icon on a device.
- Windows Hello unlock on a real Windows machine.
- "Open unlocked on this device" against a real OS credential store.
- Anything on macOS.

Known gaps inside phase 1 scope:

- A host edited and saved in a version before 0.9.0 loses its identity and
  group (older versions do not know those fields). Update every device.

- `ssh2` occasionally generates an Ed25519 key its own parser rejects;
  `apps/desktop/src/main/keys.ts` retries until the key parses.

## Work queue

Agreed with the owner: batches done in this order, **one pull request per
batch**. Batches 1 to 4 (2026-11-17) are done; batches 5 onwards were agreed on
2026-11-17 as the next queue. Whether a batch's PR becomes a release is the
owner's call (see "Releasing" in the README); a batch marked **release** has
already been agreed as one.

### Batch 1 — Everyday terminal (done)

- [x] Reconnect after a dropped connection (keep-alive was already on: 20 s, 3 missed)
- [x] Search in the scrollback
- [x] Import hosts from `~/.ssh/config`, their keys, and `known_hosts`
- [x] Sync as soon as the app comes back to the foreground or the network returns
- [x] Predictive typing: suggestions from this host's command history and snippets

### Batch 2 — Connections (done)

- [x] Jump hosts (ProxyJump), saved on the host, on desktop and Android; the
      ~/.ssh import brings `ProxyJump` across when it names one host
- [x] Port forwarding (local, remote, dynamic), saved in the vault and synced;
      runs on desktop (Android follow-up below)
- [x] SFTP browser: two panes, drag and drop, on desktop

### Batch 3 — Reliability and housekeeping (done)

- [x] Sync: items deleted while sync was off come back after signing in again.
      Deletions are now kept while sync is off and sent on rejoining (an item
      edited later on another device still wins); a new account starts without
      them
- [x] Password change: the change is noted in the vault file before it is sent,
      and the next sync finishes it (or drops the note if the server never got
      it), so a crash between the server accepting and the file being rewritten
      no longer leaves the device unable to sync
- [x] Maintenance audit (2026-11-12) leftovers: releases wait for every test,
      including the mobile and SSH ones (F05); a server image without npm and with
      fixed base packages (F02); GitHub Actions upgrades and pinning (F04);
      stricter release version checks (F06); automatic dependency-update PRs (F09)

### Batch 4 — Vault extras (done)

- [x] Encrypted export and import of the whole vault (Settings): Argon2id and
      XChaCha20-Poly1305 under a password chosen for the file; import adds
      what is missing, keeps references between items, and replaces nothing
- [x] Identities (one login shared by several hosts) and host groups
- [x] Account deletion from the app (Sync → Delete account, with the master password)

### Batch 5 — Housekeeping, rollback protection, user guide (done; **release**)

- [x] Bring this plan up to date (items shipped in batches 1–4, things since
      confirmed on devices) and a maintenance run (Electron 45.3.4; see the run
      log in `docs/MAINTENANCE.md`)
- [x] Rollback protection: each device remembers how far the vault has got, so
      a malicious or broken server cannot quietly serve an older copy
- [x] User documentation: [docs/USER-GUIDE.md](USER-GUIDE.md), every feature on
      desktop and Android

### Batch 6 — Safer releases and data (next)

- [ ] Release checks: every expected file attached and signed, update metadata
      correct; tests for the version step; actionlint and shellcheck
- [ ] Vaults made by earlier releases still open; old and new apps sync together
- [ ] Server: backup guide, an automated backup-and-restore check, storage usage
      reporting

### Batch 7 — Everyday sessions

- [ ] Per-host keep-alive interval, startup snippet, environment variables
- [ ] Terminal themes, fonts, a colour per host
- [ ] Session logs (save a session's output to a file)
- [ ] Broadcast input to several panes at once

### Batch 8 — Android catches up

- [ ] Port forwarding on Android
- [ ] Start chosen forwards when the app opens
- [ ] SFTP file browser on Android

### Batch 9 — Files, part 2

- [ ] File permissions, and editing a remote file in place (desktop and Android)
- [ ] Android emulator tests in CI

### Batch 10 — Connecting in more places

- [ ] Reaching a host through a SOCKS or HTTP proxy
- [ ] SSH certificates and agent forwarding

### Batch 11 — Hardware keys and scanning

- [ ] FIDO2 / security-key keys
- [ ] Scans of the Android libraries and the server image

### Batch 12 — Windows code signing

- [ ] Sign the Windows installer (needs a certificate bought in the owner's
      name; can move earlier once there is one)

### Batch 13 — Shared vaults for teams

- [ ] Per-vault keys wrapped to each member's public key (likely two PRs)

### Back burner (only when the owner asks)

- [ ] macOS build, with Touch ID unlock and self-update (signing and notarisation)
- [ ] iOS app
- [ ] Mosh, Telnet, serial

On-device checks, for the owner when convenient (not batch work): Windows Hello
unlock and "Open unlocked on this device" on Windows; fingerprint unlock,
background sessions, keyboard behaviour and the export/import file picker on
Android.

## Phase 2 — Vault hardening and account management

The phases below are the full roadmap; the order work is done in is the work
queue above, which names the batch each open item belongs to.

- [x] Change master password: re-wraps the vault key and rotates `authKey` via `POST /v1/password`, which signs out other devices; they adopt the new keys on "Sign in again" (`Vault.adoptAccountKeys`)
- [x] "Open unlocked on this device": the vault key is kept in the OS credential
      store via Electron `safeStorage` (async API) and used at launch. A manual or
      automatic lock deletes it, so a restart cannot undo a lock. Refused on Linux
      without a real keyring. Tested in e2e with a stand-in store
      (`TERMTERM_INSECURE_KEYSTORE=1`, tests only); **not yet run against real
      DPAPI / Keychain / libsecret.**
- [x] Windows Hello unlock (`apps/desktop/src/main/hello-key-store.ts`,
      `windows-hello.ts`, `windows-hello.ps1`): the vault key encrypted under a
      key derived from a Windows Hello signature of a random challenge (Hello
      keys are TPM-backed RSA and sign deterministically). Runs through the
      system's Windows PowerShell 5.1 to reach the Windows Runtime API, so no
      native module is needed. When Hello is set up it replaces "open unlocked"
      and any silently usable copy of the key is deleted. Unit-tested with a fake
      signer; CI runs the script on Windows for the steps that need no person.
      Settings warns, next to the option, that Hello does not replace the master
      password, and the lock screen asks for the password first if it has not
      been used on that device for 14 days (`packages/ui/src/password-reminder.ts`,
      also for phone fingerprint unlock).
      The lock screen offers a choice of Windows Hello or the master password and
      starts neither until one is picked (the phone still opens its fingerprint
      prompt at once). The desktop e2e covers this flow with a stand-in signer
      (`fake-hello.ts`, `TERMTERM_FAKE_HELLO=1`, ignored by packaged apps).
      **The prompt itself has not been run**: no Windows machine with Hello was
      available. Open questions: whether the prompt comes to the front reliably
      (the script raises it by window class), and whether setup asks twice.
- [ ] Touch ID unlock on macOS (after a macOS build exists)
- [x] Auto-lock after system idle time and on sleep / screen lock (device-local `settings.json`, default 15 minutes). The idle timer itself has no automated test.
- [x] Locking keeps established SSH sessions running (hidden until unlock)
- [x] Device list and remote sign-out (`/v1/sessions*`); device names are sealed with the vault key so the server cannot read them
- [x] Rollback protection (Batch 5): a device refuses a server copy older than
      one it has seen (live items by their encrypted `updatedAt`; deleted ones
      from a sealed log in the vault file, `Vault.deletedAt`), keeps its own
      and sends it back. The server reports its newest sequence (`head`); if
      that is behind the highest this device has read or written, the device
      re-sends everything (`Vault.resyncAll`). Either way the Sync page warns
      until dismissed. Limits: a brand-new device has nothing to compare
      with, and a server can still withhold new changes (not roll back, but
      not deliver) without being noticed.
- [x] Import from `~/.ssh/config` (with `Host *` defaults; patterns and `Match`
      skipped), the keys its hosts name (or ssh's default key), and `known_hosts`
      (plain entries; hashed ones are counted and skipped). A trusted key is never
      replaced by an imported one. Desktop reads `~/.ssh`; phones take pasted text.
      Passphrase-protected keys are listed to add by hand (`packages/app/src/ssh-import.ts`,
      `VaultService.scanSshImport` / `applySshImport`, `apps/desktop/src/main/ssh-files.ts`)
- [x] Encrypted export / import of the vault (Batch 4: Settings → Export and import)
- [x] Identities (reusable username + credential shared across hosts), host groups (Batch 4)
- [ ] SSH certificates, FIDO2 / security-key keys, agent forwarding
- [x] Account deletion from the app (Batch 4: Sync → Delete account)
- [ ] Server-side storage usage reporting, server backups doc (Batch 6)

## Phase 3 — Terminal and session features

- [x] Split panes / tiling of sessions inside a tab (desktop): each tab holds a
      layout tree (`packages/ui/src/layout.ts`, unit-tested); every session is
      rendered once and placed by its tab's layout (`Workspace.tsx`), so splitting,
      moving a pane, dragging a tab into another or out again never restarts a
      session. Split right/down (a new session to the same target), drag tabs and
      pane headers onto a pane's edge, resize by dragging dividers (double-click
      evens them out), zoom, keyboard focus moves (Alt+arrows). No limit on depth
      beyond a minimum pane size. Layouts are not remembered across restarts, and
      phones keep one terminal per tab.
- [x] Local terminal tab (desktop): `apps/desktop/src/main/local-terminal.ts` runs the
      shell in a pseudo-terminal through `node-pty` (prebuilt binaries for Windows and
      macOS, N-API so no rebuild for Electron; built from source on Linux) and reports
      through the same events as SSH, so `TerminalTab` serves both. Shells are
      detected by `local-shells.ts` (unit-tested for Windows and Unix layouts); a split
      "Terminal" button lists them, Settings picks the default, Ctrl+Shift+T opens it.
      Not on Android, where apps only reach a restricted built-in shell. CI starts
      every detected shell on Windows and checks it runs a command
      (`scripts/check-local-shells.mjs`); **not yet used on a Windows desktop by hand.**
- [x] Reconnect: a session that was connected and drops (keep-alive timeout,
      reset, or the shell's channel closing without an exit status) retries after
      1, 2, 5, 10, 20 and 30 s, at once when the network returns or the app comes
      back; never after a refused host key or failed login, nor after `exit`.
      Desktop (`ssh.ts`) and Android (`SshSession.java`) report "Connection lost"
      for a drop; `TerminalTab` does the retrying
- [ ] Keep-alive settings, per-host startup snippet, env vars
- [x] Jump hosts (ProxyJump): a host names another saved host to go through,
      chains up to 5 deep, no loops (`VaultService.checkJump`). Desktop opens each
      hop over the previous one's `forwardOut` (`apps/desktop/src/main/ssh-connect.ts`,
      shared by terminals, forwards and files); Android tunnels through a
      `direct-tcpip` channel as a JSch `Proxy` (`SshSession.Through`). Each hop's
      host key and login are checked and asked about on their own (prompts say
      "(jump host)"), and each hop only gets its own key.
- [ ] SOCKS/HTTP proxy for reaching a host
- [x] Port forwarding (local, remote, dynamic SOCKS5) as vault items (`forward`),
      started and stopped on the Forwarding page, each on its own SSH connection
      (`apps/desktop/src/main/forwards.ts`, `socks.ts`); shows live connection counts,
      refuses a port already in use with a clear error. Desktop only; listed, not
      shown in the phone's navigation
- [ ] Port forwarding on Android (JSch `setPortForwardingL/R`; SOCKS needs a small server)
- [ ] Start chosen forwards automatically with the app
- [x] SFTP browser (desktop): a Files tab per host (host panel, or the folder button
      in a terminal) with this computer and the server side by side; open, up,
      typed paths, new folder, rename, delete (folders with their contents, after
      confirming); copy with the buttons, by dragging between the sides, or by
      dropping files from the system onto the server; progress per transfer; never
      overwrites (`apps/desktop/src/main/files.ts`, `packages/ui/src/FilesTab.tsx`)
- [ ] SFTP on Android; file permissions and editing a remote file in place
- [x] Search in scrollback (`@xterm/addon-search`; Ctrl+Shift+F, Cmd+F, or the magnifier)
- [ ] Terminal themes, fonts, per-host colour; session logs
- [x] Predictive typing: command history per host (a `history` vault item,
      encrypted and synced, 500 commands) plus single-line snippets, shown beside
      the cursor. The line is followed from keystrokes (`packages/ui/src/suggest.ts`)
      and given up on after Tab, arrows or history keys until Enter; a command is
      kept only if the terminal echoed it, so passwords at prompts are not
- [ ] Broadcast input to several sessions
- [ ] Mosh, Telnet, serial

## Phase 4 — Distribution and more devices

- [x] CI (`build.yml`): typecheck and unit tests always; the desktop e2e, Windows installer and server image jobs run only when that app or shared code changed (`.github/scripts/changed-areas.sh`); pushes to `main` that touch the server publish its image as `edge`
- [x] Releases (`release.yml`): one version from a tag or a manual run stamps the app, publishes Windows + Linux installers on a GitHub release, and pushes the multi-arch server image to ghcr.io (`X.Y.Z`, `X.Y`, `latest`)
- [x] In-app updates with electron-updater from GitHub releases (Settings → About, plus an Update button in the top bar); version shown in the sidebar and About
- [x] Storage cleanup (`cleanup.yml` + `.github/scripts/cleanup.sh`): prunes artifacts, run logs, caches, old releases and old image versions, keeping the newest 3. Has run for real after a release.
- [x] First real releases made; the Release workflow works end to end
- [x] Confirmed by the owner on real devices (0.6.0 → 0.6.1): the desktop app updates itself from the New update card, and the Android app downloads and installs its APK
- [ ] Code signing for the Windows installer; macOS build (needs signing and notarisation before it can self-update)
- [x] Android app (`apps/mobile`, Capacitor) reusing `packages/core`, `packages/app` and `packages/ui`:
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
  - [x] Step 4: fingerprint / face unlock (`DeviceKeyPlugin.java`: the vault key
        encrypted by an Android Keystore key that needs a biometric check and is
        invalidated by new enrolments), background sessions (`SessionService.java`,
        a `specialUse` foreground service with a notification while sessions are
        open), and the app's own icon and launch screen. The shared logic for a
        presence-protected device key is in `VaultService` and unit-tested.
        The terminal also switches the on-screen keyboard to plain typing while it
        has focus (`TerminalWebView.java`: the field is reported as a
        no-suggestions visible-password field, because keyboards ignore the web's
        autocorrect hints), and has text-size buttons in the key row. Row spacing
        and text size are per-device preferences (`packages/ui/src/terminal-prefs.ts`),
        set under Settings → Terminal on every platform.
        **None of these Android parts has been confirmed on a device**, though SSH
        sessions themselves have been used on a phone. Open questions
        for a device test: whether long-idle sessions survive Doze without a wake
        lock, and how the prompt behaves on phones with face unlock only.
  - [x] Step 5: signed `termterm-<version>.apk` on each release, when the signing key secrets are set (README, "Android signing key"). Exercised since 0.3.x: every release carries a signed APK, checked against the release certificate, and the owner has installed one over another.
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
