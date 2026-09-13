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
