# CLI Module Map

This directory contains non-entrypoint PiChamber CLI implementation. `../cli.js` stays thin: bootstrap, command wiring, signal/cancel handling, and top-level error handling belong there; domain logic belongs in focused command and helper modules.

## Commands

- `commands-serve.js`: server startup, PID/instance registry, and foreground/background lifecycle. Explicit `pichamber serve` with no setup flags opens an interactive access, port, authentication, content, and process-mode wizard. Bare `pichamber`, flag-driven runs, non-TTY, `--quiet`, and `--json` remain non-interactive.
- `commands-lifecycle.js`: stop and restart behavior. Interactive broad stops require confirmation when more than one instance will be affected; `--force` skips it.
- `commands-status.js`: running-instance and tunnel status presentation.
- `commands-logs.js`: log discovery, tailing, and follow behavior. Quiet mode emits raw log lines, while multi-instance output retains port prefixes.
- `commands-startup.js`: native startup service management. Interactive `startup enable` walks through access, port, authentication, and confirmation when no setup flags are supplied. Flag-driven, non-TTY, `--quiet`, and `--json` runs remain non-interactive. The command stores serve flags (`--port`, `--lan`/`--host`, `--ui-password`, `--api-only`) in the native service. Re-running enable rewrites and restarts a systemd unit so the new settings take effect immediately. LAN binds require a UI password, matching `pichamber serve`.
- `commands-connect-url.js`: authenticated direct/relay pairing links. Auto-started servers run silently inside the command; `--json` and non-TTY output contain only the requested machine-readable/link result, and QR art is interactive-terminal-only.
- `pichamber version` and `pichamber --version`: print the installed package version; `--json` returns the same value as JSON.
- `commands-update.js`: package update and restart coordination. Interactive updates review the old and target versions, selected server channel, and restart impact before installation; `--yes` skips confirmation. The host-local default channel is `stable`; `--channel stable|rc` overrides it for one run, and RC subscribers receive the highest available version across stable and numbered RC releases. Updates only a writable global install owned by the running CLI. Deployment preflight reports stable reason codes and instructions for containers, source checkouts, custom systemd units, ownership mismatches, and unsupported installs before changing files. Package-manager output is suppressed for `--quiet`/`--json`; results distinguish the previous, installed, and latest versions and report partial restart failures with a non-zero CLI exit. An update requested from the managed PiChamber systemd service, including its browser terminal, moves into a transient systemd unit before replacing the package and restarting `pichamber.service`. Update jobs persist non-secret progress, channel, and an exact registry-validated target version in the PiChamber run directory so clients can resume status polling after restart without a moving dist-tag changing the installation target. Installation must verify that exact version before any managed service or instance restart. Terminal job state is persisted before JSON, quiet, or interactive output, and status reads mark dead workers or workers that miss the startup grace period as failed.
- `commands-tunnel.js`: tunnel lifecycle and profile management. Interactive tunnel setup ends with a review and confirmation; fully specified flag and profile runs remain direct. Auto-started servers never write nested output into the parent command's `--quiet` or `--json` result.
- `server-runtime.js`: thin bridge over `../../server/lib/server/runtime-requirements.js`. `dev-server.js` uses the same helper for dev servers.

## Server runtime

Server needs Node.js 22.19 or newer (24 recommended) or Bun 1.4 or newer (1.4.2 recommended). `runtime-requirements.js` owns version rules and probing. `server-runtime.js` only re-exports it.

Background `serve` picks Node first. It reuses the current executable when the CLI runs on supported Node, else probes `node` on PATH, else uses the configured Bun binary. Each probe runs `bin --version` with a 5s timeout. Only stable `X.Y.Z` counts. Prerelease and build metadata fail. Old Bun that emulates a new Node version still fails on its Bun version.

`BUN_BINARY` beats `BUN_INSTALL/bin/bun` beats `bun` on PATH. A configured value is validated and fails when unsupported instead of falling through. Without config, a supported current Bun works even off PATH before PATH is probed.

Foreground `serve --foreground`, `startup enable`, and `startWebUiServer` validate the current executable only. They never probe PATH and never switch runtimes. The `startWebUiServer` gate covers direct CLI and Electron in-process startup. `startup enable` validates before it writes any service file and pins `process.execPath`, not the package manager.

Dev `dev:server` and `dev:server:watch` use the same Node-first order through `../dev-server.js`. Builds and package management stay on Bun. Docker images launch from pinned Bun 1.4.2, but background selection still prefers supported Node when present.

Upgrade note: if your system still runs Bun 1.3.14, update Bun before you restart a Bun-pinned service. The source `packageManager` pin does not replace the installed binary. Node 22.0 through 22.18 is unsupported. No session migration is needed.

Smoke: `bun run test:runtime` at the root runs `vitest run server/lib/pi/session-daemon/pi-runtime-smoke.test.js` in `packages/web`. It defaults to `process.execPath` (Vitest runs under Node). Set `PICHAMBER_TEST_RUNTIME` to an absolute server binary to run the same probes under another runtime. The file checks the bundled SDK import with pinned version parity, bundled `bin.pi --help`, credential-free `rpc get_state` to success, and a credential-free foreground `serve --foreground --api-only` that polls `/api/pi/runtime` to ready and checks parent and daemon `execPath`. It is not provider E2E. Children run with isolated dirs, an allowlisted env, and bounded timeouts.

PR checks and release call the reusable `runtime-smoke.yml` workflow on Linux across Node 22.19, Node 24, Bun 1.4.0, and Bun 1.4.2.

## Rules

- Keep `--json` output machine-readable and `--quiet` output concise.
- Validation and safety policy run in TTY and non-TTY modes alike.
- Command modules own presentation; helpers remain output-free unless they specifically format CLI output.
- `cli.js` depends on command modules; command modules must not import `cli.js`.

## Validation

Run focused CLI tests with:

```sh
bun run test -- bin/cli.test.js
```

Then run affected package type-check and lint commands.
