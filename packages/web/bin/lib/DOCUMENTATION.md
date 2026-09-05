# CLI Module Map

This directory contains non-entrypoint PiChamber CLI implementation. `../cli.js` stays thin: bootstrap, command wiring, signal/cancel handling, and top-level error handling belong there; domain logic belongs in focused command and helper modules.

## Commands

- `commands-serve.js`: server startup, PID/instance registry, and foreground/background lifecycle. Explicit `pichamber serve` with no setup flags opens an interactive access, port, authentication, content, and process-mode wizard. Bare `pichamber`, flag-driven runs, non-TTY, `--quiet`, and `--json` remain non-interactive.
- `commands-lifecycle.js`: stop and restart behavior. Interactive broad stops require confirmation when more than one instance will be affected; `--force` skips it.
- `commands-status.js`: running-instance and tunnel status presentation.
- `commands-logs.js`: log discovery, tailing, and follow behavior. Quiet mode emits raw log lines, while multi-instance output retains port prefixes.
- `commands-startup.js`: native startup service management. Interactive `startup enable` walks through access, port, authentication, and confirmation when no setup flags are supplied. Flag-driven, non-TTY, `--quiet`, and `--json` runs remain non-interactive. The command stores serve flags (`--port`, `--lan`/`--host`, `--ui-password`, `--api-only`) in the native service. Re-running enable rewrites and restarts a systemd unit so the new settings take effect immediately. LAN binds require a UI password, matching `pichamber serve`.
- `commands-connect-url.js`: authenticated direct/relay pairing links.
- `pichamber version` and `pichamber --version`: print the installed package version; `--json` returns the same value as JSON.
- `commands-update.js`: package update and restart coordination. Interactive updates review the old and target versions and restart impact before installation; `--yes` skips confirmation. Updates only a global install owned by the running CLI. Results distinguish the previous, installed, and latest versions and report partial restart failures. A Linux user systemd unit is restarted in place; the command does not spawn a replacement server on the same port.
- `commands-tunnel.js`: tunnel lifecycle and profile management. Interactive tunnel setup ends with a review and confirmation; fully specified flag and profile runs remain direct.

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
