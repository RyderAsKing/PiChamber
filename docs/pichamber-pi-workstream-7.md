# PiChamber Pi Migration: Workstream 7 Implementation Record

## Status and scope

This record documents the completed Workstream 7 (Remote, desktop, and deployment lifecycle) for the PiChamber Pi migration plan:

- Single-owner authentication and connection model: password login, passkeys, trusted-device bearer tokens, pairing, direct server URLs, LAN, reverse proxy, private networks (Tailscale), Desktop SSH forwarding, and host switching.
- Web server supervision of private daemon lifecycle (`createPiSessionDaemonSupervisor`):
  1. `pichamber serve` starts or reuses one session daemon for its host.
  2. The server health-checks the private daemon (`runtime.health`) and reconnects automatically after web server restarts.
  3. `pichamber stop` gracefully stops both the public web server and its private daemon.
  4. Electron starts the same daemon as agent-runtime infrastructure while keeping the PiChamber backend in Electron's in-process boundary.
  5. Planned daemon shutdown/restart waits for active work to settle where practical.
  6. Daemon failure is reported as an explicit service error (`503`/`DAEMON_UNAVAILABLE`), interrupting active runs and triggering authoritative client resync.

## Implemented lifecycle & supervision architecture

| Component | Responsibility / Contract |
| --- | --- |
| Supervisor | `packages/web/server/lib/pi/session-daemon/supervisor.js` manages local daemon process start/reuse/stop and authentication verification. |
| Server Integration | `packages/web/server/index.js` instantiates supervisor on startup, exposes public health at `/api/pi/runtime`, and registers daemon stop in graceful shutdown hooks. |
| Desktop Boundary | `packages/electron/main.mjs` imports `startWebUiServer` in-process, starting the web server and supervising the private session daemon in-process without sidecars. |
| CLI Commands | `packages/web/bin/lib/commands-serve.js` and `commands-lifecycle.js` handle single/daemon host startup and shutdown via server `/api/pichamber/shutdown`. |

## Validation evidence

- `bun test packages/web/server/lib/pi/session-daemon/supervisor.test.js`
- `bun test packages/web/server/lib/pi`
- `bun run type-check:web`
- `bun run type-check:ui`
- `bun run type-check:electron`
- `bun run lint:web`
- `bun run lint:ui`
- `bun run lint:electron`
- `bun run dead-code`
