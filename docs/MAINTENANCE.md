# Maintenance policy

How to keep termterm's dependencies, toolchain and code patterns current and
safe. It is written to be handed to an AI coding agent (or followed by a
person) every week or two:

> Read `docs/MAINTENANCE.md` and carry out a maintenance run.

A run ends with either a pull request or a short note that nothing needed
changing, plus a new row in the [run log](#run-log) at the bottom of this file.

## Goals, in priority order

1. **No known vulnerabilities** in anything that ships: the desktop app, the
   sync server image, and the libraries bundled into them.
2. **Nothing deprecated or broken** in use: no deprecated APIs, no
   end-of-life runtimes, no abandoned packages.
3. **Stay close to current** releases so that upgrades remain small.
4. **Never trade away safety or behaviour for freshness.** An upgrade that
   weakens the security model or cannot be verified is not made.

## What there is to maintain

| Area | Where | Notes |
|---|---|---|
| npm packages | `package.json`, `packages/core/package.json`, `apps/server/package.json`, `apps/desktop/package.json`, one root `package-lock.json` | npm workspaces. The server has no runtime dependencies on purpose. |
| Electron | `apps/desktop/package.json` (`electron`, pinned exactly) | Security-critical: it bundles Chromium and Node. electron-builder needs an exact version. |
| Node.js | `engines` in `package.json`, `node-version` in `.github/workflows/*.yml`, `FROM node:…` in `apps/server/Dockerfile` | All three must agree on the major version. The server relies on type stripping and `node:sqlite`. |
| GitHub Actions | `uses:` lines in `.github/workflows/*.yml` | Pinned by major version tag. Includes one third-party action with delete rights over the image registry (`dataaxiom/ghcr-cleanup-action` in `cleanup.yml`): review its changes before moving to a new major. |
| Docker base image | `apps/server/Dockerfile` | Rebuilt on every release and every push to `main`. |
| Cryptography | `packages/core/src/crypto.ts` | Argon2id parameters, HKDF, XChaCha20-Poly1305. See "Cryptography review". |

## Procedure

Work on a fresh branch from `main`. Do the steps in order; stop and report if
a step in "Ask first" applies.

### 1. Establish a clean baseline

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
xvfb-run -a npm run e2e
```

(`xvfb-run -a` is only needed on Linux without a display.) If the baseline is
already failing, fix or report that first: do not start upgrades on a red tree.

### 2. Security

```bash
npm audit
```

- Fix every finding that affects shipped code (anything reachable from
  `dependencies`, or bundled into the app: `ssh2`, `electron-updater`,
  `hash-wasm`, `@noble/*`, `@xterm/*`, `react`, `electron`).
- Findings confined to build-time tooling (for example inside
  `electron-builder`) are lower priority, but still upgrade when a fixed
  version exists. Record any you leave, with the reason, in the run log.
- Never run `npm audit fix --force`: it makes unreviewed major upgrades.
- Check Electron against its security releases: the installed major must
  still be a supported one (Electron supports the latest three majors). If it
  is not, upgrading Electron is the most important item of the run.
- Check that the Node.js major in use is still in active or maintenance LTS.

### 3. Updates

```bash
npm outdated
```

- **Patch and minor updates:** take them all, together, in one commit.
- **Major updates:** one package (or one tightly coupled family, such as
  `react` + `react-dom` + `@types/react*`, or `vite` + `electron-vite` +
  `@vitejs/plugin-react`) per commit. Read the release notes or migration
  guide first and apply the code changes it calls for. Do not rely on memory
  for what changed: look it up.
- **GitHub Actions:** check each `uses:` action for a newer major version and
  for deprecation notices from GitHub (old Node runtimes in actions get
  retired on a schedule).
- **Docker base image and Node:** move to a newer Node LTS when one is in
  active LTS and Electron, the CI config and the Dockerfile can all move
  together.

### 4. Deprecations and code patterns

Upgrading versions is not enough; the code must also stop using what has been
deprecated.

- Run the app's test suite and builds and read the output for deprecation
  warnings: Node (`DeprecationWarning`, `ExperimentalWarning` changes),
  Electron (`(electron) '…' is deprecated`), Vite, React, TypeScript and
  electron-builder all print them. Each one is a task.
- Search the type definitions of the main frameworks for `@deprecated` on any
  API this code calls. For Electron: `node_modules/electron/electron.d.ts`.
- Re-check each item under "Known workarounds" below: remove the workaround
  when its cause is fixed, and update this file.
- Skim the release notes of Electron, React, Vite, electron-vite, xterm.js and
  ssh2 since the last run for recommended pattern changes, and adopt the ones
  that apply.

### 5. Verify

Everything from step 1 must pass again, plus:

```bash
npm run dist
```

on at least one platform, to prove packaging still works (it also runs in CI
on Windows for every pull request). For an Electron, electron-builder or
electron-updater upgrade, additionally confirm in the pull request's CI that
the **Windows installer** job is green.

Never make a check pass by weakening it: do not skip, delete or loosen a test,
and do not add `skipLibCheck`-style escapes for new errors.

### 6. Deliver

Open one pull request titled `Maintenance: <date>` that lists what was
upgraded (from → to), what was deliberately left and why, any code changes
made for deprecations, and the verification that was run. Add the run-log row
in the same pull request.

## Ask first

Stop and ask the repository owner before doing any of these:

- Changing anything in `packages/core/src/crypto.ts`, the vault file format,
  or the sync protocol. These affect whether existing vaults can be opened.
- Replacing a dependency with a different library, or adding a new runtime
  dependency (especially to the server, which has none).
- Loosening the Electron security settings in `apps/desktop/src/main/index.ts`
  (`sandbox`, `contextIsolation`, CSP, navigation blocking), even if an
  upgrade guide suggests it.
- An upgrade whose migration is large enough to change behaviour users see.
- Dropping support for a platform or raising the minimum OS version.

## Cryptography review

Every third run or so, check current guidance rather than assuming:

- Argon2id parameters (`DEFAULT_KDF` in `packages/core/src/crypto.ts`) against
  the current OWASP password-storage recommendations. Raising them applies to
  new vaults and password changes only; existing vaults keep the parameters
  stored in the file. `KDF_LIMITS` must continue to accept the old values.
- `@noble/ciphers`, `@noble/hashes` and `hash-wasm` for security advisories
  and audits.
- Report findings to the owner; changing parameters is an "Ask first" item.

## Known workarounds

Things in the code that exist because of a bug or limitation elsewhere. Check
each run whether the cause has gone away.

| Where | Workaround | Remove when |
|---|---|---|
| `apps/desktop/src/main/keys.ts` (`generateKey`) | Regenerates until the key parses: `ssh2`'s generator emits an unparseable Ed25519 key about 1 time in 400. | An `ssh2` release fixes it. Verify by generating a few thousand keys and parsing each. |
| `apps/desktop/package.json` (`npmRebuild: false`) | Skips rebuilding `ssh2`'s optional native modules for Electron; `ssh2` falls back to pure JavaScript. | Not required to remove. Revisit if `ssh2` performance matters. |
| `apps/server` scripts and Dockerfile (`--disable-warning=ExperimentalWarning`) | `node:sqlite` is still marked experimental in Node 22. | The Node version in use marks `node:sqlite` stable. |
| `apps/server/tsconfig.src.json` (`erasableSyntaxOnly`) | The server runs from TypeScript source via Node's type stripping, which rejects enums and parameter properties. | Keep: it is a guard, not a hack. |
| `apps/desktop/src/main/device-key.ts` | Uses Electron's asynchronous `safeStorage` API; the synchronous one is deprecated. `TERMTERM_INSECURE_KEYSTORE` exists only for tests. | Keep. Watch for further `safeStorage` API changes. |
| `apps/desktop/src/main/updater.ts` | `TERMTERM_UPDATE_FEED` points an unpackaged build at a test feed; packaged builds ignore it. | Keep. Must never be honoured by a packaged build. |
| `apps/desktop/package.json` (`electron` pinned exactly) | electron-builder refuses a version range. | Keep. Bump the exact version during maintenance. |

## Baseline at the time of writing

- `npm audit`: 6 moderate findings, all inside `electron-builder`'s own
  dependencies (build-time tooling, not shipped in the app).
- `npm outdated`: only `@types/node`, held at 22.x on purpose to match the
  Node 22 runtime.
- No deprecation warnings from the app's own code. Node prints an
  `ExperimentalWarning` for `node:sqlite` in tests (expected, see above).

## Run log

Add a row per run, newest first.

| Date | By | Upgraded | Left alone (why) | Notes |
|---|---|---|---|---|
| 2026-11-11 | initial | n/a | n/a | Policy written; baseline recorded above. |
