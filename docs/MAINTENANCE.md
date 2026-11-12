# Maintenance policy

How to keep termterm's dependencies, toolchain and code patterns current and
safe. It is written to be handed to an AI coding agent (or followed by a
person) every week or two:

> Read `docs/MAINTENANCE.md` and carry out a maintenance run.

A run ends with either a pull request or a short note that nothing needed
changing, plus a new row in the [run log](#run-log) at the bottom of this file.

## Goals, in priority order

1. **No known vulnerabilities** in anything that ships: the desktop app, the
   Android app, sync server image, and the libraries bundled into them.
2. **Nothing deprecated or broken** in use: no deprecated APIs, no
   end-of-life runtimes, no abandoned packages.
3. **Stay close to current** releases so that upgrades remain small.
4. **Never trade away safety or behaviour for freshness.** An upgrade that
   weakens the security model or cannot be verified is not made.

## What there is to maintain

| Area | Where | Notes |
|---|---|---|
| npm packages | the root `package.json` and one in each folder under `packages/` and `apps/`, with a single root `package-lock.json` | npm workspaces. The server has no runtime dependencies on purpose. |
| Electron | `apps/desktop/package.json` (`electron`, pinned exactly) | Security-critical: it bundles Chromium and Node. electron-builder needs an exact version. |
| Node.js | `engines` in `package.json`, `node-version` in `.github/workflows/*.yml`, `FROM node:…` in `apps/server/Dockerfile` | Document the supported development/CI and server Node versions; ensure `engines` and tests cover them. Electron bundles its own Node runtime and does not have to match the server. The server relies on type stripping and `node:sqlite`. |
| GitHub Actions | `uses:` lines in `.github/workflows/*.yml` | Currently pinned by major version tag; migrate to verified full commit SHAs with version comments and automated update proposals. Review permissions and changes, especially actions with signing, publishing or registry deletion access. |
| Android toolchain | `apps/mobile/android` (`variables.gradle`, `build.gradle`, `gradle/wrapper/gradle-wrapper.properties`), `java-version` in build and release workflows | Capacitor sets the expected Gradle, Android Gradle Plugin, JDK and SDK levels. Upgrade Capacitor majors with its migration guide (`npx cap migrate`), and raise `targetSdkVersion` when Google Play's requirement moves. |
| node-pty (local terminal) | `apps/desktop/package.json` (dependency and the `build.files` / `asarUnpack` entries for it) | A native module. Its prebuilt binaries (Windows, macOS) use N-API, so they work across Electron versions; Linux builds it from source on install. After upgrading it, run `node apps/desktop/scripts/check-local-shells.mjs` and confirm the Windows CI job is green. |
| Android SSH libraries | `apps/mobile/android/app/build.gradle` (`com.github.mwiede:jsch`, `org.bouncycastle:bcprov-jdk18on`) and the same versions with checksums in `apps/mobile/ssh-test/run.sh` | Security-critical: they implement SSH on Android. Not covered by `npm audit`; check Maven Central and each project's advisories. Update both files together and run `npm run test:ssh -w @termterm/mobile`. |
| Docker base image | `apps/server/Dockerfile` | Built on releases and relevant pushes to `main`; scan the resulting image, including OS packages. |
| Cryptography | `packages/core/src/crypto.ts` | Argon2id parameters, HKDF, XChaCha20-Poly1305. See "Cryptography review". |

## Procedure

Work on a fresh branch from `main`. Do the steps in order; stop and report if
a step in "Ask first" applies.

### 1. Establish a clean baseline

Record the starting commit and the actual Node/npm, Electron, JDK, Android SDK
and OS versions used. Check prerequisites first: a JDK with `javac` for the
Java SSH tests, JDK 21 and the compatible Android SDK for current APK builds,
and a display or Xvfb for desktop tests. Re-check these requirements when
upgrading the toolchain. Distinguish missing tooling from application failures.

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

```bash
npm run e2e:mobile
```

```bash
npm run test:ssh -w @termterm/mobile
```

(`xvfb-run -a` is only needed on Linux without a display. The mobile test needs a Chromium-based browser: set `CHROME_PATH` to an installed one, or run `npx playwright install chromium` in `apps/mobile`.) If the baseline is
already failing, fix or report that first: do not start upgrades on a red tree.

### 2. Security

```bash
npm audit
```

- Fix every finding that affects shipped code (anything reachable from
  `dependencies`, or bundled into the app: `ssh2`, `electron-updater`,
  `hash-wasm`, `@noble/*`, `@xterm/*`, `react`, `electron`).
- Assess build tooling by exposure, not only by whether it ships. Install
  scripts, build tools and Actions can access signing or publishing credentials.
- Check Android Maven dependencies (including JSch and Bouncy Castle) against
  upstream advisories and scan the built server image for OS/package findings.
  `npm audit` does not cover either of these surfaces.
- For every deferred finding, record the advisory URL/ID, component/version,
  severity, reachable exposure, mitigation or reason for deferral, owner and
  next review date. Link the record from the run log. Do not call a scan clean
  when a required scanner was unavailable. Prioritize exploitable shipped-code
  and credential-exposure findings; explain any unresolved release risk.
- Never run `npm audit fix --force`: it makes unreviewed major upgrades.
- Check Electron against its security releases: the installed major must
  still be a supported one (Electron supports the latest three majors). If it
  is not, upgrading Electron is the most important item of the run.
- Check that the Node.js major in use is still in active or maintenance LTS.

### 3. Updates

```bash
npm outdated
```

- **Patch and minor updates:** use small, independently reviewable groups:
  Electron/updater, Android/SSH, cryptography, and ordinary tooling. Keep
  tightly coupled packages together. Read release notes even for minor changes;
  a version label is not a guarantee of compatibility.
- **Major updates:** one package (or one tightly coupled family, such as
  `react` + `react-dom` + `@types/react*`, or `vite` + `electron-vite` +
  `@vitejs/plugin-react`) per commit. Read the release notes or migration
  guide first and apply the code changes it calls for. Do not rely on memory
  for what changed: look it up.
- **GitHub Actions:** check each `uses:` action for a newer major version and
  for deprecation notices from GitHub (old Node runtimes in actions get
  retired on a schedule).
- **Docker base image and Node:** choose a supported LTS and verify server
  dependencies, type stripping, SQLite and build tooling before adopting it.
  Keep development/CI and server versions documented and compatible; assess
  Electron's bundled Node and Android's JDK independently.
- **Automated discovery:** configure Dependabot or Renovate for weekly update
  proposals covering supported npm, Actions, Docker and Gradle dependencies.
  Verify coverage rather than assuming one bot finds everything. Keep the
  grouping above and require the applicable checks before merging. For Java
  SSH updates, keep Gradle declarations and test-script checksums in sync.

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

After dependency or implementation changes, repeat the baseline checks and
require the relevant platform checks below. Documentation-only edits require
review of the changed text and references, not application builds.

| Change area | Required verification |
|---|---|
| Desktop dependencies or code | Desktop e2e and a Windows installer build (`npm run dist` on Windows); verify the Linux package when its packaging/runtime is affected. |
| Android dependencies or code | Mobile browser e2e, Java SSH tests, and `npm run apk -w @termterm/mobile`. Capacitor, native SSH, storage or lifecycle changes also need device/emulator smoke testing. |
| Server dependencies, runtime or image | Core/server tests, server image build and health check, persistence and expected runtime UID checks. |
| Shared vault, app or UI dependencies/code | Both desktop and Android checks, plus server checks when crypto, sync or server-consumed code is affected. |
| Actions, release or cleanup scripts | Workflow validation (for example actionlint), shell validation (for example ShellCheck), and focused tests of changed selection/version logic; preview cleanup with its dry-run mode. |

Record the actual job results for the tested commit. Build CI conditionally
skips jobs based on changed paths: a green workflow with a skipped required
job is not evidence that the platform passed. Run the missing job through
an appropriate manual build or equivalent check and link the result.

**Existing data and upgrades.** For vault, crypto, sync, persistence or runtime
changes, use synthetic fixtures generated by previous supported releases.
Verify unlock, hosts, credentials, keys and known hosts survive; test sync
between old and new clients against supported server versions. Never commit
real user vaults or credentials. For server storage changes, back up a test
database using a SQLite-consistent procedure, restore into an isolated instance,
and verify that clients can sign in and recover their items. Record fixture
versions and results. Do not promise downgrade compatibility after an
irreversible migration; document recovery before release.

**Platform behaviour.** Credential-store changes need a real Windows DPAPI
check; sleep/idle/lock changes need the corresponding OS checks. Android native
changes need an installed-app test of the bridge, authentication, keyboard,
resize, background/resume and vault persistence. Browser and plain-Java tests
do not substitute for that test. Updater/signing changes need an installed
previous-version-to-candidate upgrade that preserves the vault, with the
signing identity and installer behavior verified.

**Release checks.** Before publishing, validate the version and expected assets,
installer/update metadata, and Android signing when an APK is intended. Trim
only surrounding whitespace and an optional leading `v`; reject embedded
whitespace and invalid versions. Test stable/prerelease inputs, duplicate tags,
and invalid input. Verify that updater metadata points to the correct assets
and that APK signatures/version codes support installation over the previous
release. An intentionally desktop-only release must explicitly report the
missing APK. Run mobile browser and Java SSH tests for the exact release
commit before releasing Android, even if an earlier build passed. Use an
isolated test feed or prerelease channel for upgrade checks; do not publish a
production release merely to complete a maintenance check.

Missing automation must be reported as a gap, not a passing check. Perform
an equivalent manual check where feasible; otherwise leave affected work
explicitly unverified and do not mark it ready to release.

Never make a check pass by weakening it: do not skip, delete or loosen a test,
and do not add `skipLibCheck`-style escapes for new errors.

### 6. Deliver

Open one pull request titled `Maintenance: <date>` that lists what was
upgraded (from → to), what was deliberately left and why, any code changes
made for deprecations, and the verification that was run. Add the run-log row
in the same pull request. Include the starting and tested commit SHAs, tool/OS
versions, exact checks and CI links, manual device results, and any blocked or
skipped checks with reasons. Link deferred advisories and follow-up work with
owners and review dates. Make clear whether the change is ready to merge and
whether platform/release verification is still outstanding.

## Automation to add

These are follow-up implementation tasks, not checks supplied by this policy
edit. Mark them complete only when their implementation and evidence exist.

- [ ] Previous-release synthetic vault fixtures and mixed-version sync tests.
- [ ] Automated server backup/restore verification.
- [ ] Native Android device/emulator smoke coverage and targeted Windows
      credential-store and installed-upgrade coverage.
- [ ] Mobile browser and Java SSH tests in the release workflow; expected-asset,
      signing and update-metadata validation.
- [ ] Version-normalisation/validation tests; trim surrounding whitespace only.
- [ ] Scheduled dependency proposals, verified Action SHA pins with version
      comments, workflow and shell validation, and Maven/container scans.

Prioritize platform verification, existing-data compatibility and release
checks. Preserve an explicit manual verification path until automation lands.

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

## Historical baseline — 2026-11-11

These are observations recorded when this policy was written, not current
scan results or permanent version recommendations. Re-run checks and consult
upstream release/support information on every maintenance run. Policy-only
edits do not refresh this baseline.

- `npm audit`: 6 moderate findings, all inside `electron-builder`'s own
  dependencies (build-time tooling, not shipped in the app).
- `npm outdated`: only `@types/node`, held at 22.x on purpose to match the
  Node 22 runtime.
- GitHub Actions: the `actions/*` steps are on `v4`, which GitHub now runs on a newer Node than they target and flags as deprecated. Newer majors exist (for example `actions/checkout@v7`, `actions/upload-artifact@v7`, `actions/download-artifact@v8`). Move to them one action at a time, checking each one's inputs against its release notes, since `release.yml` and `cleanup.yml` depend on artifact options.
- No deprecation warnings from the app's own code. Node prints an
  `ExperimentalWarning` for `node:sqlite` in tests (expected, see above).

## Run log

Add a row per run, newest first.

| Date | By | Upgraded | Left alone (why) | Notes |
|---|---|---|---|---|
| 2026-11-12 | Codex | Policy only; no dependency upgrades | Runtime code and workflows unchanged | Added platform, compatibility and release verification; security deferral records; runtime distinctions; update grouping and automation backlog. Documentation reviewed; no maintenance suite run. |
| 2026-11-11 | initial | n/a | n/a | Policy written; baseline recorded above. |
