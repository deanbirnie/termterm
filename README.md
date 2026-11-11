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

What comes next is tracked in [docs/PLAN.md](docs/PLAN.md). Keeping
dependencies current and safe is covered by [docs/MAINTENANCE.md](docs/MAINTENANCE.md).

## Layout

| Path | What |
|---|---|
| `packages/core` | Vault crypto, item model and sync client (portable TypeScript) |
| `packages/app` | App logic shared by every client: the vault service and the contract between the interface and the platform |
| `packages/ui` | The React interface, shared by desktop and mobile |
| `apps/desktop` | Electron desktop app |
| `apps/mobile` | Android app: the shared interface in a Capacitor shell (in progress) |
| `apps/server` | Sync server: Node 22, built-in SQLite, no runtime dependencies |

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

## Installing the app

Download the latest version from the repository's
[Releases](https://github.com/deanbirnie/termterm/releases/latest) page:

- **Windows:** `termterm-<version>-setup.exe`. The installer is not
  code-signed yet, so Windows SmartScreen shows a warning the first time:
  choose **More info → Run anyway**. A `-portable.exe` that runs without
  installing is there too.
- **Linux:** `termterm-<version>-x86_64.AppImage`.

Installed copies update themselves. When a newer release exists an **Update**
button appears in the top bar; you can also check by hand under
**Settings → About**, which shows the version you are running. The app
downloads the new installer only when you click, then asks to restart. The
portable build and builds run from source do not self-update.

To build installers yourself (Node 22.18+): `npm install`, then `npm run dist`.
The files land in `apps/desktop/release/`.

## Android app (in progress)

`apps/mobile` is the Android app. Today it does the vault and sync: create or
sign in to a vault, view and edit hosts, snippets and known hosts, and sync
with your other devices. **It cannot open SSH sessions or create keys yet**;
those arrive with the native SSH plugin (see the plan).

Every build that touches the mobile app produces a debug APK as the
**termterm-android-debug** artifact on its Actions run. It is for trying
out: each run signs with a different throwaway key, so a newer one will not
install over an older one. Uninstalling removes the vault stored on the phone,
so set up sync first; signing in again brings everything back. Properly signed
APKs on the releases page come later.

To work on it:

```bash
npm run dev:mobile
```

opens the interface in a browser, where phone emulation in the developer tools
is enough for most work. Building the APK needs JDK 21 and the Android SDK:

```bash
npm run apk -w @termterm/mobile
```

The sync server address must be `https://` on Android, which blocks plain
HTTP from apps by default.

## Running the sync server

The server is published as a Docker image for amd64 and arm64:

```bash
docker pull ghcr.io/deanbirnie/termterm-server:latest
```

| Tag | What it tracks |
|---|---|
| `latest` | the newest stable release |
| `0.2`, `0.2.0` | a release line, or one exact release |
| `edge` | the current `main` branch |

From a checkout, `docker compose up -d` starts it on `127.0.0.1:8787` with its
database in a named volume, and `docker compose pull && docker compose up -d`
updates it. Put a reverse proxy that terminates TLS in front of it (Traefik,
Caddy, nginx) and use that `https://` address in the app. On Dokploy, create a
Compose service pointing at this repository and `docker-compose.yml`, then add
a domain for port 8787. `GET /v1/health` reports the running version.

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

## Releasing

One version number covers the app, the GitHub release and the server image.
It comes from the release itself, not from `package.json` (whose `0.1.0` is
only what source builds report).

To publish a version, open **Actions → Release → Run workflow** and enter a
version such as `0.2.0`. Pushing a tag does the same:

```bash
git tag v0.2.0
```

```bash
git push origin v0.2.0
```

The workflow runs the tests, then:

1. builds the Windows installer and Linux AppImage stamped with that version;
2. pushes `ghcr.io/deanbirnie/termterm-server` tagged `0.2.0`, `0.2` and `latest`;
3. creates the GitHub release `v0.2.0` with the installers and the update
   metadata the in-app updater reads.

Use [semantic versioning](https://semver.org). A version with a suffix, such as
`0.3.0-beta.1`, is published as a pre-release: it gets its own image tag but
does not move `latest`, and installed apps are not offered it.

The first time the image is published, GitHub creates the package as private.
To pull it without logging in, open the package on your GitHub profile →
**Package settings → Change visibility → Public**.

## Storage cleanup

`.github/workflows/cleanup.yml` runs weekly and after every release, and
removes what is no longer needed:

| What | Kept |
|---|---|
| GitHub releases (installers) | the newest 4, and always the one marked latest; git tags are kept |
| Server image versions | `latest`, `edge` and the newest 4 tagged versions; untagged leftovers are removed |
| CI build artifacts | the newest 3 of each kind, and at most 7 days; release staging copies for 1 day |
| Workflow runs and logs | 30 days |
| Dependency caches | those used in the last 7 days; none for closed pull requests |

The numbers are in the `env` block at the top of that file. To preview a run
without deleting anything, start it from **Actions → Cleanup → Run workflow**
with **dry run** ticked.

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
