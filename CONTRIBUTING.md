# Contributing to PiChamber

PiChamber is open to contributions. It is a Pi-native workspace with web,
desktop, hosted-mobile, and Capacitor mobile clients. The Pi SDK owns sessions,
providers, prompts, skills, extensions, and the session daemon. PiChamber owns
the workspace UI, server lifecycle, authentication, device connections, relay,
and native shells.

Please open an issue or discussion before starting a large feature. Small fixes,
documentation improvements, tests, and platform reports are welcome without a
proposal.

## Prerequisites

- Bun 1.3.14, as declared by the root `package.json`
- Node.js 22 or newer
- Git
- A supported operating system for the package you are changing

You do not need to install a separate Pi CLI for development. The web package
uses the pinned Pi SDK dependency and the desktop app starts the web server in
its own Electron process.

Desktop packaging has extra platform requirements. Read
[`packages/electron/README.md`](./packages/electron/README.md) before packaging.
Mobile development needs Xcode, CocoaPods, JDK 21, and Android SDK 35. Read
[`packages/mobile/README.md`](./packages/mobile/README.md) before building a
native app.

## Get the repository ready

```bash
git clone https://github.com/RyderAsKing/PiChamber.git
cd PiChamber
bun install
```

Run commands from the repository root unless a section says otherwise.

## Development commands

### Web

| Command | Use | Default endpoint |
| --- | --- | --- |
| `bun run dev` | Vite HMR UI plus the API server | UI `5180`, API `3902` |
| `bun run dev:web:full` | Build watcher plus the static Express server | `3001` |
| `bun run dev:web:hmr` | The same HMR flow as `dev` | UI `5180`, API `3902` |
| `bun run start:web` | Start the packaged web server | `3000` |
| `bun run stop` | Stop a local PiChamber server managed by the CLI | Depends on the instance |

Open the UI URL printed by `bun run dev`. The API endpoint is not the HMR
page. Set `PICHAMBER_HMR_UI_PORT`, `PICHAMBER_HMR_API_PORT`, or
`PICHAMBER_HMR_HOST` when the defaults do not fit your setup.

Lower-level watchers are also available as `bun run dev:web` for the web build
and `bun run dev:web:server` for the server. Most contributors should use
`bun run dev`.

### Desktop

```bash
bun run electron:dev
bun run electron:dev:bundled
bun run electron:build
```

`electron:dev` uses the HMR UI. `electron:dev:bundled` uses built web assets.
`electron:build` packages the current operating system and writes artifacts to
`packages/electron/dist`.

Desktop targets are macOS, Windows, and Linux. macOS produces DMG and ZIP
artifacts, Windows produces an NSIS installer, and Linux produces an AppImage
for the native x64 or arm64 host. Unsigned local installers are expected when
signing credentials are not configured.

### Shared UI

`packages/ui` is a source-level library used by the web and desktop runtimes.
It has no standalone server.

```bash
bun run build:ui
bun run type-check:ui
bun run lint:ui
bun run test:ui
```

### Mobile

The Capacitor app connects to an existing PiChamber server. It does not start a
local Pi daemon on the phone or tablet.

```bash
bun run mobile:build
bun run mobile:sync
bun run mobile:build:android:debug
bun run mobile:build:ios:simulator
bun run mobile:sim:run
```

Use the simulator helpers in the `serve-sim` skill for headless iOS work. The
mobile package README contains Android device commands and platform setup.

### Documentation

The source of truth for public docs is
`packages/docs/content/docs/`. Validate it with:

```bash
bun run docs:validate
```

The docs website is maintained in the separate `pichamber-website` repository.
Do not edit generated website copies in this repository.

## Validation

Use the narrowest checks that cover your change. The common workspace checks
are:

```bash
bun run type-check
bun run lint
bun run test
bun run build
```

`bun run test` runs the web, UI, and Electron unit suites. Mobile has package
scoped type-check and lint scripts, while native builds are validated through
the mobile workflows or platform tools.

Useful focused commands include:

```bash
bun run --cwd packages/web test -- bin/cli.test.js
bun run --cwd packages/electron test:architecture
bun run --cwd packages/electron test:updater
bun run docs:validate
bun run dead-code
```

`dead-code` is non-blocking. Read its report when you add, delete, rename, or
change exports. `bun run doctor` checks the React source tree for common issues.

Before a release, `bun run release:prepare` runs the build, type-check, and lint
steps. `bun run release:test` exercises the native macOS Electron packaging
path. Windows and Linux packaging run on their native GitHub Actions runners;
use the desktop smoke workflow for those targets.

## Code and documentation conventions

- Keep Pi behavior behind the Pi client and `/api/pi/*` contracts. Do not
  recreate Pi session or provider logic in shared UI code.
- Keep runtime-specific behavior explicit for web, desktop, hosted mobile, and
  Capacitor mobile.
- Keep Electron entrypoints and preload bridges thin. Enforce privileged
  operations in the main process.
- Use strict TypeScript and avoid `any` without a concrete reason.
- Reuse the existing semantic theme tokens, shared buttons, and sprite icons.
- Keep components compatible with light and dark themes.
- Prefer early returns and focused modules over deep nesting.
- Do not add dependencies unless the change needs one and the dependency is
  discussed in the pull request.
- Update the nearest `DOCUMENTATION.md`, package README, or public docs when a
  contract or ownership rule changes.
- Do not add secrets, bearer tokens, pairing credentials, or user session data
  to source, tests, screenshots, logs, or issues.

Before editing, read [`AGENTS.md`](./AGENTS.md), the nearest package README and
module documentation, and every matching skill under `.agents/skills/`.

## Pull requests

A pull request should be easy to review without reconstructing the intent from
the diff.

Before opening one:

1. Keep the change focused. Separate unrelated cleanup.
2. Read the repository guidance that applies to the changed packages and
   runtimes.
3. Run the focused validation plus any broader check required by the affected
   contract.
4. Complete [the pull request template](.github/PULL_REQUEST_TEMPLATE.md) with
   current evidence.

Describe all of the following:

- **Intent:** the problem and the resulting behavior
- **Non-goals:** nearby behavior intentionally left unchanged
- **Affected surfaces:** packages, runtimes, persisted data, routes, CLI output,
  or other external contracts
- **Repository guidance:** which skills and owning docs applied, and how the
  change follows them
- **Validation:** exact commands, results, and anything not verified
- **Risk and failure behavior:** compatibility, security, cleanup, rollback,
  performance, and partial-failure behavior where relevant

User-visible changes need current visual evidence. Use screenshots for static
states and a short recording for motion, focus, gestures, drag-and-drop, or
multi-step interactions. Include narrow and wide layouts, light and dark themes,
and loading or error states when they are part of the change. For docs-only or
non-rendered changes, explain why visual evidence is not applicable.

## Release process

The desktop release workflow builds macOS, Windows, and Linux artifacts. A tag
also builds the Android release artifact. Publishing `@pi-chamber/web` is
explicit through the Release workflow, and iOS TestFlight uses the separate
Mobile Release workflow.

To prepare version `X.Y.Z`:

1. Run `bun run version:bump X.Y.Z`. This updates the root, UI, web, and
   Electron manifests. It intentionally does not change `packages/mobile`.
2. Move the notes from `CHANGELOG.md` under `[Unreleased]` into a dated heading
   exactly named `## [X.Y.Z] - YYYY-MM-DD`.
3. Run `bun run release:prepare`, `bun run docs:validate`, and the focused
   release checks for the platforms being published.
4. Merge the release commit to `main`.
5. Push `vX.Y.Z`, or dispatch the **Release** workflow with `version=X.Y.Z`.

A tag builds and uploads desktop artifacts and Android artifacts. To publish the
npm package, dispatch the workflow with `publish_npm=true`. To build Android
from a manual dispatch, enable `publish_mobile`. The root release workflow does
not upload iOS; use **Mobile Release** for TestFlight.

The release workflow creates a draft, checks the changelog and package
versions, verifies updater manifests, and publishes the draft after the desktop
jobs succeed. Review the draft assets before making the release public.

Release credentials are configured only in GitHub Actions secrets. Depending on
the artifacts being published, the workflows use Apple signing and notarization
secrets, `NPM_TOKEN`, Android signing secrets, iOS provisioning and App Store
Connect secrets, and `PICHAMBER_WEBSITE_REPO_TOKEN`. Never put their values in a
commit or issue.

## Community and support

- Report reproducible bugs with the [bug report template](https://github.com/RyderAsKing/PiChamber/issues/new?template=bug_report.yml).
- Propose features with the [feature template](https://github.com/RyderAsKing/PiChamber/issues/new?template=feature_request.yml).
- Ask questions in [GitHub Discussions](https://github.com/RyderAsKing/PiChamber/discussions).
- Report security issues using [SECURITY.md](./SECURITY.md), not a public issue.
