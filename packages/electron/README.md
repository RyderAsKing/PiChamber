# PiChamber Desktop

Electron is PiChamber's native desktop shell for macOS, Windows, and Linux.

## Runtime

`main.mjs` starts `@pi-chamber/web/server/index.js` in the Electron main process. It never starts a server sidecar or manages an external coding-agent binary. Development loads the HMR UI; packaged builds load staged assets from `pichamber-ui://` while the in-process loopback server remains the authenticated API backend. Unpackaged `electron ./main.mjs` reports host Electron version `0.0`; main pins `package.json` (or `0.0.0-dev`) onto `app.setVersion` before constructing `electron-updater`.

The preload bridge exposes only desktop-owned capabilities. Main-process handlers enforce every privileged action; remote pages do not receive local filesystem, shell, token, or host privileges.

## Development

```bash
bun run electron:dev
bun run electron:dev:bundled
bun run --cwd packages/electron type-check
bun run --cwd packages/electron test:architecture
```

## Packaging

```bash
bun run electron:build
```

Packaging builds web assets, bundles the Electron main process, rebuilds native modules, and runs electron-builder. It stages only the web UI and native desktop resources; Pi sessions are served by the in-process PiChamber server. Local dictation uses the same in-process server and loads the packaged `sherpa-onnx` addon only in its forked STT worker. PiChamber's UI is currently English-only, so electron-builder retains only Chromium's English locale pack (`en-US` on Windows/Linux and `en` on macOS) instead of shipping every Chromium translation. The staged `resources/web-dist` is the packaged UI; build filters exclude `@pi-chamber/web/dist` from `app.asar` so those same assets are not shipped twice.

Windows desktop uses the same Pi SDK as the [Pi CLI](https://pi.dev/docs/latest): sessions live under `%USERPROFILE%\.pi\agent`, private IPC is a named pipe, and the bash tool needs Git for Windows (or another `bash.exe` on PATH), matching [Pi's SDK](https://pi.dev/docs/latest/sdk).

Desktop PNG/ICO/ICNS brand assets, web favicons, and mobile launcher/splash PNGs are generated from the PiChamber SVG mark with `bun run icons:brand`. The macOS 26 `Assets.car` catalog still requires `bun run --cwd packages/electron generate:macos-icon` on a Mac with Xcode.

GitHub Releases for this package are produced by `.github/workflows/release.yml`. Desktop is the default published artifact; npm and mobile jobs stay disabled unless a workflow dispatch explicitly enables them. See `CONTRIBUTING.md` for the version/tag steps.

macOS notarized builds need `APPLE_CERTIFICATE` as base64 of a Developer ID Application `.p12`. Missing or unreadable certificates produce unsigned `.dmg`/`.zip` files instead of failing the job.

## Platform rules

- Keep native windows, menus, updater, deep-link, and IPC behavior in this package.
- Keep shared UI behavior in `packages/ui` and server behavior in `packages/web`.
- Background processes on Windows must use direct hidden spawns (`windowsHide: true`) and never `cmd.exe` wrappers.
- Validate both HMR and bundled UI startup after changing startup, preload, routing, or packaging.
