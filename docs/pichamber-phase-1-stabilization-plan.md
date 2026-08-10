# PiChamber Phase 1 Stabilization Plan

## Purpose

Finish the PiChamber identity stabilization before beginning the Pi SDK spike.

This plan addresses six concrete inconsistencies left after the initial rebrand:

1. PiChamber data is split between `~/.config/pichamber` and `~/.config/openchamber`.
2. PWA startup code and UI persistence use different localStorage keys.
3. Global package ownership detection still searches for the `openchamber` executable.
4. The Unreleased changelog claims namespace changes that have not happened.
5. Update checks contact a placeholder hosted API by default.
6. Process identity accepts any command line containing a broad product-name substring.

The output of this work is a coherent PiChamber baseline. It does not introduce the Pi SDK, remove the OpenCode runtime, or rename the still-active OpenChamber protocol namespaces.

## Decisions

These decisions are fixed for this stabilization pass:

- The default PiChamber application-data root is `~/.config/pichamber`.
- `OPENCHAMBER_DATA_DIR` remains the explicit data-root override for now. Renaming environment variables is a separate contract migration.
- An explicit data-root override applies to every PiChamber-owned file beneath the application-data root, including settings, projects, themes, credentials, goals, walkthrough data, temporary integration files, and managed-process records.
- Do not read, copy, rename, or delete `~/.config/openchamber` data. Legacy-data migration is out of scope.
- PWA storage uses only the four `pichamber.*` keys named in this plan. Do not add fallback reads for old keys.
- The shipped CLI executable and package identity are `pichamber` and `@pichamber/web` only.
- HTTP routes, custom events, IPC/bridge commands, window globals, metadata keys, and the `openchamber-ui://` protocol remain unchanged unless explicitly listed here.
- A hosted update API is opt-in through the existing override environment variable. No placeholder host is contacted by default.
- Existing OpenCode runtime behavior remains intact until Phase 2.

## Non-goals

- Pi SDK installation or integration.
- OpenCode SDK, process, proxy, or SSE removal.
- Migration of existing OpenChamber settings, sessions, credentials, PID files, localStorage, or Docker volumes.
- Renaming `OPENCHAMBER_*` environment variables.
- Renaming `/api/openchamber/*` routes.
- Renaming `openchamber:*` events, Electron IPC channels, VS Code bridge commands, or window globals.
- Renaming `openchamber-ui://` or `openchamber://` URL schemes.
- Fixing the four web test failures already present on the current baseline unless a stabilization change touches their owning behavior.

## Invariants

### Data-root authority

- Every PiChamber-owned path is derived from one effective data root.
- The effective data root is the normalized `OPENCHAMBER_DATA_DIR` value when non-empty; otherwise it is `<home>/.config/pichamber`.
- No production module independently hardcodes `<home>/.config/openchamber`.
- A custom data root must not leave projects, themes, auth, goals, or other side stores under the default root.
- Web, CLI, Electron, and VS Code must resolve equivalent inputs to equivalent paths.
- OpenCode-owned paths such as `~/.config/opencode` and `~/.local/share/opencode` are not PiChamber data-root violations.

### PWA persistence

- Startup readers and UI writers use exactly the same key constants.
- The four keys are:

  ```text
  pichamber.pwaName
  pichamber.pwaOrientation
  pichamber.mobileKeyboardMode
  pichamber.pwaRecentSessions
  ```

- Existing normalization and limits remain unchanged.
- A write from Settings must affect the next PWA startup without an intermediate key translation.

### Updates

- Default update checks contact only authoritative publication sources.
- Web/CLI package versions come from the npm `@pichamber/web` dist-tag.
- GitHub release metadata and assets come from `RyderAsKing/PiChamber`.
- `api.pichamber.dev` is not contacted unless an operator explicitly configures `OPENCHAMBER_UPDATE_API_URL`.
- Failure to reach one source must produce an explicit unavailable/no-update result according to the owning surface; it must not trust an unrelated fallback artifact.
- Update responses never advertise an OpenChamber package, release, APK, or executable.

### Process identity

- A stale PID file cannot authorize terminating an unrelated live process.
- Identity is based on recognized executable or entrypoint tokens, not an arbitrary substring anywhere in a command line.
- Accepted identities are limited to PiChamber's installed package entrypoints, PiChamber source-checkout entrypoints, and the `pichamber` executable name.
- An argument, username, hostname, or unrelated path that merely contains `pichamber` is not sufficient.
- Live `/api/system/info` confirmation remains the higher authority when it is available.

## Workstream 1: Make the PiChamber Data Root Authoritative

### 1.1 Add the canonical web/CLI resolver

Add a pure path resolver under the published web package:

```text
packages/web/server/lib/pichamber-data-dir.js
```

The module should own:

```text
resolvePiChamberDataDir
resolvePiChamberDataPath
```

Requirements:

- Accept injected environment, home-directory, and path dependencies for deterministic tests.
- Trim and resolve a non-empty `OPENCHAMBER_DATA_DIR` override.
- Fall back to `path.join(home, '.config', 'pichamber')`.
- Keep path derivation pure; do not create directories or perform migration.
- Do not expose an OpenChamber fallback.

Use this resolver in both server and CLI code instead of duplicating fallback logic.

### 1.2 Update web-server owners

Replace inline data-root derivation or hardcoded legacy roots in:

```text
packages/web/server/index.js
packages/web/server/lib/small-model/index.js
packages/web/server/lib/github/auth.js
packages/web/server/lib/opencode/managed-process-registry.js
packages/web/server/lib/opencode/proxy.js
packages/web/server/lib/walkthrough/store.js
packages/web/server/lib/walkthrough/model-settings.js
packages/web/server/lib/ui-auth/ui-passkeys.js
packages/web/server/lib/ui-auth/ui-auth.js
packages/web/server/lib/git/identity-storage.js
packages/web/server/lib/git/service.js
packages/web/server/lib/session-assist/runtime.js
packages/web/server/lib/session-goal/runtime.js
packages/web/server/lib/session-goal/objectives.js
packages/web/server/lib/quota/credentials/store.js
packages/web/server/lib/package-manager.js
```

`packages/web/server/index.js` must derive all of these from the same effective root:

```text
settings.json
push-subscriptions.json
apns-tokens.json
remote-clients.json
client-pairing-sessions.json
cloudflare tunnel state
themes/
projects/
speech-models/
install-id files
```

In particular, remove the current split where `OPENCHAMBER_DATA_DIR` controls settings but themes/projects still derive directly from `os.homedir()`.

Prefer dependency injection for focused runtimes where a data directory is already passed by the composition root. Do not add new module-level environment reads when the owner can receive an explicit path.

### 1.3 Update CLI owners

Make `packages/web/bin/lib/cli-paths.js` delegate to the canonical resolver, then update the remaining bypass:

```text
packages/web/bin/lib/commands-connect-url.js
```

All CLI-owned paths must resolve beneath the same root:

```text
settings.json
run/
logs/
tunnel profiles
pairing/session files
install IDs where CLI-owned
```

Keep the already-renamed `pichamber-<port>.pid`, `.json`, and `.log` filenames. Do not scan old run directories or old filename prefixes.

### 1.4 Align Electron

Update `packages/electron/main.mjs` so `settingsFilePath()`, the SSH manager, settings mutations, desktop port persistence, and the in-process web server use the same resolved data root.

Because Electron already depends on `@pichamber/web`, import the pure resolver from the published web package rather than maintaining another literal fallback.

Acceptance scenario:

1. Start Electron with a temporary `OPENCHAMBER_DATA_DIR`.
2. Persist a desktop setting and an SSH instance.
3. Start/read through the in-process server.
4. Confirm every resulting PiChamber-owned file is beneath the temporary root and no default-root file is created.

### 1.5 Align VS Code

VS Code does not depend on the web package. Add one VS Code-owned pure resolver with the same contract and use it from:

```text
packages/vscode/src/opencode.ts
packages/vscode/src/quotaCredentials.ts
packages/vscode/src/bridge-settings-runtime.ts
packages/vscode/src/bridge-system-runtime.ts
packages/vscode/src/opencodeProcessRegistry.ts
```

Preserve specialized override variables such as `OPENCHAMBER_MANAGED_PROCESS_REGISTRY` only where they already intentionally override one child path.

Add parity tests that assert the web and VS Code resolvers produce the same default and `OPENCHAMBER_DATA_DIR` result for equivalent inputs.

### 1.6 Stop the shared UI from reconstructing the root

`packages/ui/src/lib/pichamberConfig.ts` must not assume that the server root is always `<home>/.config/pichamber`, because a remote server may use `OPENCHAMBER_DATA_DIR`.

Extend the existing home-directory capability instead of introducing a second request:

- Web `GET /api/fs/home` returns both `home` and the authoritative `pichamberDataDir`.
- The VS Code `api:fs/home` bridge returns the same shape.
- `pichamberConfig.ts` uses `pichamberDataDir/projects` when supplied.
- The existing `<home>/.config/pichamber/projects` derivation remains only a narrow compatibility fallback for a PiChamber runtime too old to return `pichamberDataDir`; it is not an OpenChamber-data fallback.

Update the web filesystem route tests, VS Code bridge tests, and project-config tests to lock this contract.

### 1.7 Align Docker, development tooling, and documentation

Keep the new Docker mount:

```text
./data/pichamber:/home/openchamber/.config/pichamber
```

The container account name is not a product data-root contract and does not need to change in this pass.

Update `scripts/oc-dev.mjs` to use `~/.config/pichamber/oc-dev.json`, or rename the helper in a separate explicit change if its command/file identity is also being rebranded.

After production paths are coherent, update owning documentation so every documented path matches the resolver. Do not rewrite historical changelog entries that described the path used by an old release.

### 1.8 Data-root tests

Add or update focused tests for:

- Default root: `<home>/.config/pichamber`.
- Whitespace-trimmed absolute/relative override normalization.
- Every child path stays beneath the effective root.
- Themes and projects honor `OPENCHAMBER_DATA_DIR`.
- Electron settings and server settings resolve to the same file.
- Web and VS Code managed-process registries resolve to equivalent directories.
- `/api/fs/home` and the VS Code bridge expose `pichamberDataDir`.
- No production fallback contains `.config/openchamber` after the change.

Update the explicit legacy path in:

```text
packages/web/server/lib/walkthrough/reproduce-2607.test.js
```

Do not mechanically rewrite temporary test directories that use an arbitrary name and are not asserting the product default.

## Workstream 2: Align PWA Storage Keys

### 2.1 Define shared UI key constants

Create or extend a small browser-safe PWA persistence module in `packages/ui/src/lib/` that exports the four canonical key constants.

Update:

```text
packages/ui/src/lib/persistence.ts
packages/ui/src/lib/mobileKeyboardMode.ts
packages/ui/src/lib/pwa.ts
packages/ui/src/hooks/usePwaManifestSync.ts
```

to use only `pichamber.*` keys.

`packages/web/index.html` runs before the React bundle and cannot import TypeScript. Keep its literals synchronized with the shared constants through a focused contract test that reads the HTML and asserts all four keys match the exported UI values.

Do not rename unrelated localStorage keys, custom events, or window globals in this workstream.

### 2.2 Preserve behavior

Keep the current normalization rules:

- PWA name whitespace normalization and 64-character limit.
- Orientation values: `system`, `portrait`, `landscape`.
- Mobile keyboard values: `native`, `resize-content`.
- Recent-session deduplication and count/title/id limits.

Do not copy values from old keys. The first PiChamber run starts with server/default values until the user changes a setting.

### 2.3 PWA tests

Add tests proving:

- Settings writes and removes `pichamber.pwaName`.
- Mobile keyboard mode reads and writes `pichamber.mobileKeyboardMode`.
- Recent sessions use `pichamber.pwaRecentSessions`.
- `index.html` references exactly the four canonical key names.
- No production file in the PWA flow references the corresponding `openchamber.*` keys.

## Workstream 3: Fix PiChamber Executable Ownership Detection

Update `packages/web/server/lib/package-manager.js` so global-bin and package-manager ownership checks recognize only the shipped identities:

```text
pichamber
pichamber.cmd
@pichamber/web
```

Specifically:

- `getOwnedPackagePathsFromGlobalBins()` probes `pichamber` or `pichamber.cmd`.
- `isPackageInstalledWith()` validates `@pichamber/web`, not a generic `openchamber` substring.
- Resolved real paths must still map back to the owning package root before an update command is executed.

Add focused package-manager tests for Unix and Windows binary names, package-list output, and rejection of similarly named unrelated packages.

## Workstream 4: Make Default Update Sources Authoritative

### 4.1 Make the hosted API optional

Change the hosted update URL from a placeholder default to an optional configured value:

```text
OPENCHAMBER_UPDATE_API_URL unset/blank => do not call a hosted update API
OPENCHAMBER_UPDATE_API_URL set         => call that exact configured endpoint
```

Apply this rule in both:

```text
packages/web/server/lib/package-manager.js
packages/vscode/src/bridge.ts
```

Do not substitute `api.pichamber.dev` when the variable is absent.

### 4.2 Define default source ownership by surface

- Web/CLI package update availability is authoritative from the npm `@pichamber/web` `latest` dist-tag.
- Release notes may be read from the PiChamber changelog after the version is confirmed by npm.
- Desktop continues to use Electron's existing GitHub updater feed for `RyderAsKing/PiChamber`.
- Mobile/VS Code downloadable artifacts, when supported, resolve from PiChamber GitHub Releases and must select an asset matching the requested platform and package type.
- If no authoritative artifact exists, return an explicit unavailable/no-update result; never select the first unrelated asset.

Keep a configured hosted API as an optional deployment integration. Its claims must still be cross-checked against the authoritative publication source for the relevant surface before being shown or installed.

### 4.3 Update tests

Rewrite `packages/web/server/lib/package-manager.test.js` so default-path tests do not mock or expect `api.pichamber.dev`.

Cover:

- No hosted API request when the override is absent.
- Exact configured endpoint use when the override is present.
- npm-confirmed web update.
- npm no-update and unavailable cases.
- GitHub release lookup uses only `RyderAsKing/PiChamber`.
- Android selects the canonical PiChamber APK and rejects AAB-only/unrelated releases.
- No OpenChamber package/release URL appears in a result.
- VS Code follows the same opt-in hosted-API rule.

## Workstream 5: Tighten Process Identity

Replace broad substring matching in `packages/web/bin/lib/cli-process.js` with token/path-aware matching.

Recognize only:

- `pichamber`, `pichamber.cmd`, or `pichamber.exe` as an executable token.
- `@pichamber/web/bin/cli.js`.
- `@pichamber/web/server/index.js`.
- `PiChamber/packages/web/bin/cli.js`.
- `PiChamber/packages/web/server/index.js`.

Account for `/` and `\` separators and quoted paths containing spaces. Do not accept:

- OpenChamber checkout/package paths.
- `pichamber` appearing only in an unrelated argument.
- usernames, hostnames, project files, or package names that merely contain the text.
- generic `cli.js` or `server/index.js` paths without a PiChamber package/check-out identity.

Rename the internal helper to `isPiChamberCmdline` and update internal call sites/tests in the same change. Preserve a compatibility export only if current PiChamber code still imports the old symbol; do not preserve behavior for OpenChamber executables.

Update `packages/web/bin/cli.test.js`:

- Change the OpenChamber-positive fixture to a negative case.
- Rename spawned test markers to `pichamber-*`.
- Add quoted Unix path, Windows path, package path, and direct executable positives.
- Add substring-collision negatives such as an editor opening `/tmp/pichamber-notes`, `ssh pichamber@example`, and an unrelated package containing the word.
- Keep stale/recycled PID and live system-info confirmation tests.

## Workstream 6: Correct the Changelog

Update only the Unreleased rebrand entry after the code work is complete.

It must state:

- The VS Code command namespace was renamed to `pichamber.*`.
- The four PWA-specific localStorage keys were renamed to `pichamber.*` in this stabilization pass.
- `/api/openchamber/*` remains the sole active HTTP route prefix.
- `openchamber:*` custom events, `api:openchamber:*` bridge commands, `__openchamber*` window globals, and URL schemes remain unchanged and deferred.
- The effective PiChamber data root is `~/.config/pichamber`, overridable by `OPENCHAMBER_DATA_DIR`.
- No automatic import from `~/.config/openchamber` is provided.
- Default update checks use authoritative npm/GitHub sources; a hosted API requires explicit configuration.

Do not claim dual route prefixes. Do not describe read fallback as completed data migration. Do not rewrite historical release entries to describe current paths.

## Implementation Order

Execute the work in this order so each boundary becomes authoritative before its consumers move:

1. Add and test the canonical data-root resolver.
2. Move web-server and CLI path owners to the resolver.
3. Align Electron and VS Code runtime boundaries.
4. Expose the authoritative data root through the existing filesystem home capability and update shared project configuration.
5. Align PWA storage readers/writers and add key-contract tests.
6. Fix executable ownership detection.
7. Make hosted updater use opt-in and rewrite update-source tests.
8. Tighten process identity and its lifecycle fixtures.
9. Update docs and the Unreleased changelog to the final implemented state.
10. Run focused, workspace-wide, and runtime validation.

Do not mix Pi SDK work into any step.

## Validation Plan

### Focused automated checks

```bash
bun run --cwd packages/web test --run bin/
bun run --cwd packages/web test --run server/lib/package-manager.test.js
bun run --cwd packages/web test --run server/lib/opencode/pichamber-routes.test.js
bun run --cwd packages/web test --run server/lib/fs/routes.test.js
bun run --cwd packages/web test --run server/lib/github/
bun run --cwd packages/web test --run server/lib/ui-auth/
bun run --cwd packages/web test --run server/lib/quota/
bun run --cwd packages/web test --run server/lib/session-goal/
bun run --cwd packages/web test --run server/lib/walkthrough/
bun run --cwd packages/electron test:architecture
bun run --cwd packages/vscode type-check
```

Run the exact new resolver, PWA-key, executable-ownership, update-source, and process-identity test files directly as they are added.

### Workspace checks

```bash
bun run type-check
bun run lint
bun run docs:validate
bun run build:web
bun run dead-code
git diff --check
```

Inspect the non-blocking dead-code report because this plan adds a shared resolver and may rename an exported process helper.

### Full web regression suite

```bash
bun run --cwd packages/web test
```

Current recorded baseline:

```text
4 failed test files
4 failed tests
129 passed test files
1173 passed tests
3 skipped tests
```

Known baseline failures:

```text
server/lib/context-obligatory/runtime.test.js
server/lib/opencode/skills.test.js
server/sse-routes.test.js
src/api/git.test.ts
```

Acceptance requires no additional failures. If these baseline failures are fixed independently before this plan lands, the acceptance target becomes a fully green suite.

### Runtime smoke tests

Use a disposable temporary data root and home directory. Never point smoke tests at a developer's real configuration.

Verify:

1. CLI serve/status/stop reads and writes only the configured data root.
2. Web settings, themes, projects, GitHub auth, passkeys, quota data, goals, and walkthrough state remain under that same root.
3. Electron settings and its in-process server observe the same `settings.json`.
4. VS Code settings and managed-process registry resolve to the PiChamber root.
5. PWA name, orientation, keyboard mode, and recent sessions survive reload under the new keys.
6. A stale PID pointing at an unrelated process is rejected and never terminated.
7. With no update API override, no request is sent to `api.pichamber.dev`.
8. A configured update API cannot cause installation of an artifact absent from the authoritative npm/GitHub source.

## Completion Criteria

Phase 1 stabilization is complete when:

- Production search finds no PiChamber-owned fallback to `~/.config/openchamber`.
- All PiChamber-owned data respects one effective root and its explicit override.
- PWA readers and writers use the same four `pichamber.*` keys.
- Package ownership detection finds only `pichamber` and `@pichamber/web`.
- Default update checks contact no placeholder hosted API.
- Process identity rejects product-name substring collisions and all OpenChamber-only paths.
- The changelog describes the actual namespace state without claiming aliases that do not exist.
- Focused tests, type-check, lint, docs validation, web build, and diff checks pass.
- The full web suite has no regressions beyond the recorded baseline.
- A disposable-root web/Electron smoke test demonstrates that no PiChamber subsystem writes to a second root.

Only after these criteria are met should Phase 2 begin with the isolated Pi SDK spike.
