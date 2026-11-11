# termterm

An SSH client that keeps your hosts, keys and passwords in an end-to-end
encrypted vault and syncs it between your devices through a small server you
host yourself.

- **Vault** — hosts, SSH keys (generate or import), snippets and known host
  keys, encrypted on disk with your master password.
- **Sync** — every device holds a full copy; changes merge through a sync
  server that only ever stores ciphertext.
- **Terminal** — SSH sessions in tabs (xterm.js), password / key /
  keyboard-interactive login, host key verification, run snippets in a session.

What comes next is tracked in [docs/PLAN.md](docs/PLAN.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | Vault crypto, item model and sync client (portable TypeScript) |
| `apps/server` | Sync server: Node 22, built-in SQLite, no runtime dependencies |
| `apps/desktop` | Electron + React desktop app |

## Getting started

Requires Node 22.18 or newer.

```bash
npm install
```

```bash
npm run dev
```

Other commands:

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run e2e
```

`npm run e2e` builds the desktop app and drives two instances of it against a
throwaway SSH server and sync server. On Linux without a display, run it as
`xvfb-run -a npm run e2e`.

## Installing on Windows

Every push builds a Windows installer in GitHub Actions:

1. Open the repository's **Actions** tab and pick the latest **Build** run.
2. Download the **termterm-windows** artifact and unzip it.
3. Run `termterm-<version>-setup.exe` to install, or
   `termterm-<version>-portable.exe` to run without installing.

Pushing a tag such as `v0.1.0` also attaches both files to a GitHub release.

The installer is not code-signed yet, so Windows SmartScreen shows a warning
the first time: choose **More info → Run anyway**.

To build it yourself on a Windows machine (Node 22.18+):

```bash
npm install
```

```bash
npm run dist
```

The files land in `apps/desktop/release/`. The same command produces a DMG on
macOS and an AppImage on Linux.

## Running the sync server

With Docker, from the repository root:

```bash
docker compose up -d --build
```

This starts the server on `127.0.0.1:8787` with its database in a named
volume. Put a reverse proxy that terminates TLS in front of it (Traefik,
Caddy, nginx) and use that `https://` address in the app. On Dokploy, create a
Compose service pointing at this repository and `docker-compose.yml`, then add
a domain for port 8787.

Without Docker, for local testing:

```bash
npm run server
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `TERMTERM_DB` | `./data/termterm.db` | SQLite database path |
| `TERMTERM_ALLOW_REGISTRATION` | `true` | Set to `false` once your account exists |
| `TERMTERM_TRUST_PROXY` | `false` | Use `X-Forwarded-For` for login throttling; enable only behind your own proxy |

Then in the app: **Sync → Create account and sync** on the first device, and
**I already have one** on the start screen of every other device.

## Security model

- The master password never leaves the device and is never stored.
  Argon2id (64 MiB, 3 passes) turns it into a master key, from which two
  independent keys are derived with HKDF: one wraps the random 256-bit vault
  key, the other authenticates to the sync server (which hashes it again with
  scrypt before storing it).
- Every item is encrypted separately with XChaCha20-Poly1305 under the vault
  key, bound to its item id. The server and the vault file on disk contain
  only ciphertext: no labels, addresses, usernames or item types.
- In the desktop app, secrets live only in the Electron main process. The UI
  runs in a sandboxed renderer with a strict CSP and receives redacted data
  (for example "a password is saved", never the password). Private keys cannot
  be read back out through the UI.
- Server host keys are trusted on first use and stored in the vault, so a
  changed key is flagged on all your devices. Credentials are not sent until
  the host key is accepted.

- The vault locks itself after 15 minutes without input (configurable) and
  when the computer sleeps or its screen is locked. Open SSH sessions keep
  running behind the lock screen.
- Optionally, the vault key can be kept in the operating system's credential
  store (DPAPI, Keychain, or the desktop keyring) so the app opens unlocked.
  Locking the vault removes that stored key until the password is next entered.
- The Sync page lists the devices signed in to your account and can sign any
  of them out. Device names are encrypted too.
- Changing the master password re-wraps the vault key and signs your other
  devices out of sync until they enter the new password.

Known limits, also listed in the plan: a forgotten master password cannot be
recovered, and a malicious sync server could withhold updates or serve an older
copy of an item (it cannot read or forge one).
