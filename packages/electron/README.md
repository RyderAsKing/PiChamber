# PiChamber Desktop

Electron is PiChamber's native desktop shell for macOS, Windows, and Linux.

## Runtime

`main.mjs` starts `@pichamber/web/server/index.js` in the Electron main process. It never starts a server sidecar or manages an external coding-agent binary. Development loads the HMR UI; packaged builds load staged assets from `openchamber-ui://` while the in-process loopback server remains the authenticated API backend.

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

Packaging builds web assets, bundles the Electron main process, rebuilds native modules, and runs electron-builder. It stages only the web UI and native desktop resources; Pi sessions are served by the in-process PiChamber server.

## Platform rules

- Keep native windows, menus, updater, deep-link, SSH, and IPC behavior in this package.
- Keep shared UI behavior in `packages/ui` and server behavior in `packages/web`.
- Background processes on Windows must use direct hidden spawns (`windowsHide: true`) and never `cmd.exe` wrappers.
- Validate both HMR and bundled UI startup after changing startup, preload, routing, or packaging.
