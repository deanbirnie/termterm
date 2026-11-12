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
| `apps/mobile` | Android app: the shared interface in a Capacitor shell, with a native SSH plugin |
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
- **Android:** `termterm-<version>.apk` (see [Android app](#android-app)).

Installed copies update themselves. When a newer release exists an **Update**
button appears in the top bar; you can also check by hand under
**Settings → About**, which shows the version you are running. The app
downloads the new installer only when you click, then asks to restart. The
portable build and builds run from source do not self-update.

To build installers yourself (Node 22.18+): `npm install`, then `npm run dist`.
The files land in `apps/desktop/release/`.

## Android app

`apps/mobile` is the Android app: the same interface in a native shell, with
SSH provided by a native plugin. It does vault, sync and terminal sessions
(password, key and keyboard-interactive logins, host key verification), with an
extra key row for Esc, Tab, Ctrl and the arrows. Unlocking with a fingerprint
and keeping sessions alive in the background are not there yet.

**Installing:** download `termterm-<version>.apk` from the
[Releases](https://github.com/deanbirnie/termterm/releases/latest) page and
open it on the phone. Android asks once to allow installs from your browser
or file manager. A newer version installs over an older one and keeps the
vault. The app does not update itself: Settings → About tells you where to
get the new APK.

The app accepts a plain `http://` sync server address, for a server on your
home network, and warns when you enter one. Use `https://` for anything
reachable from outside.

### Android signing key

Android only installs an update over an existing app when both are signed
with the same key, so releases need one fixed signing key. It is kept in
repository secrets, never in the repository. **Until it is set up, releases
are published without an APK.** Set it up once:

1. Create a keystore (any machine with Docker; choose your own password in
   both places):

```bash
docker run --rm -v "$PWD":/out eclipse-temurin:21-jdk keytool -genkeypair -keystore /out/termterm-release.jks -alias termterm -keyalg RSA -keysize 4096 -validity 10000 -storepass 'CHOOSE-A-PASSWORD' -keypass 'CHOOSE-A-PASSWORD' -dname "CN=termterm"
```

2. Print it as one line of text:

```bash
base64 -w0 termterm-release.jks
```

3. In the repository on GitHub, open **Settings → Secrets and variables →
   Actions → New repository secret** and add four secrets:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the output of step 2 |
| `ANDROID_KEYSTORE_PASSWORD` | the password you chose |
| `ANDROID_KEY_ALIAS` | `termterm` |
| `ANDROID_KEY_PASSWORD` | the same password |

4. Keep `termterm-release.jks` and its password somewhere safe (a password
   manager). **If they are lost, no future version can install over the ones
   already on your phones**: you would have to uninstall and reinstall.

Builds on pull requests and `main` still produce a debug APK as the
`termterm-android-debug` artifact. That one is signed with a throwaway key
and will not install over a release version or another debug build.

### Working on it

```bash
npm run dev:mobile
```

opens the interface in a browser, where phone emulation in the developer tools
is enough for interface work (SSH needs the real app). The SSH core is plain
Java and has its own test, which needs only a JDK and Node:

```bash
npm run test:ssh -w @termterm/mobile
```

Building the APK needs JDK 21 and the Android SDK:

```bash
npm run apk -w @termterm/mobile
```

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

The image name is `termterm-server` (not `termterm`). The server has no web
page of its own: to check it is up, open `http://<host>:8787/v1/health`.

Running the container directly, for example from Unraid's Docker tab:

```bash
docker run -d --name termterm-sync --restart unless-stopped -p 8787:8787 -e PUID=99 -e PGID=100 -v /mnt/user/appdata/termterm-sync:/data ghcr.io/deanbirnie/termterm-server:latest
```

The container takes ownership of the mounted `/data` folder for `PUID:PGID`
and then runs as that user, so a folder Docker created as root works without
any manual `chown`. `99:100` is Unraid's `nobody:users`; leave both out to use
`1000:1000`.

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
| `PUID` / `PGID` | `1000` / `1000` | Docker only: the user and group the server runs as, and that will own the files in `/data` |

Then in the app: **Sync → Create account and sync** on the first device, and
**I already have one** on the start screen of every other device.

Once your account exists, set `TERMTERM_ALLOW_REGISTRATION` to `false`,
especially if the server is reachable from the internet; otherwise anyone who
finds the address can create accounts on it.

### Removing an account

There is no account deletion in the app yet. On the server, list the accounts:

```bash
docker exec termterm-sync node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/termterm.db');console.table(db.prepare('SELECT u.username, (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id) AS items, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS devices FROM users u ORDER BY u.id').all())"
```

and delete one, with its stored items and device sign-ins, by putting its
username at the end (there is no undo):

```bash
docker exec termterm-sync node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/termterm.db');db.exec('PRAGMA foreign_keys = ON');const r=db.prepare('DELETE FROM users WHERE username = ?').run(process.argv[1]);console.log('accounts deleted:',r.changes)" USERNAME
```

Replace `termterm-sync` with your container's name. Devices keep their own
full copy of the vault, so an account deleted by mistake can be recreated from
any of them: turn sync off there and create the account again.

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

1. builds the Windows installer, the Linux AppImage and the signed Android APK, all stamped with that version;
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
| GitHub releases, with all their files (installers, APK) | the newest 3, and always the one marked latest; git tags are kept |
| Server image versions | `latest`, `edge` and the newest 3 tagged versions; untagged leftovers are removed |
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

- On Android the vault and the interface run in one process, so the
  desktop's separation between them does not exist there. The app loads no
  remote content, and SSH runs in a native plugin.

Known limits, also listed in the plan: a forgotten master password cannot be
recovered, and a malicious sync server could withhold updates or serve an older
copy of an item (it cannot read or forge one).
