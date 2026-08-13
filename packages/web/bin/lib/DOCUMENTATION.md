# CLI Module Map

This directory contains non-entrypoint PiChamber CLI implementation. `../cli.js` stays thin: bootstrap, command wiring, signal/cancel handling, and top-level error handling belong there; domain logic belongs in focused command and helper modules.

## Commands

- `commands-serve.js`: server startup, PID/instance registry, and foreground/background lifecycle.
- `commands-lifecycle.js`: stop and restart behavior.
- `commands-status.js`: running-instance and tunnel status presentation.
- `commands-logs.js`: log discovery, tailing, and follow behavior.
- `commands-startup.js`: native startup service management.
- `commands-connect-url.js`: authenticated direct/relay pairing links.
- `commands-update.js`: package update and restart coordination.
- `commands-tunnel.js`: tunnel lifecycle and profile management.

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
