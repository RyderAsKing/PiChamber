# Pi Session Daemon

## Purpose

This module is the Pi-owned Week 0 runtime spike. It creates one `AgentSessionRuntime` with the Pi SDK, keeps it behind a private local socket, and maps a small event subset to the PiChamber IPC contract. It is not a public HTTP route and browsers never connect to it.

## Entrypoints

- `session-daemon.js`
  - `createPiSessionRuntime({ cwd, agentDir })` creates a persistent Pi runtime using the selected server-side cwd and Pi agent directory. It uses Pi's normal settings, credentials, models, sessions, skills, prompts, and context discovery, with native extensions explicitly disabled for the core milestone.
  - `createSessionDaemon(options)` starts/stops the authenticated local socket daemon and validates its endpoint and setup inputs.
- `session-daemon.test.js` tests the disposable socket spike with an injected session runtime; it never loads a developer's Pi home, credentials, or sessions.

## Protocol and security invariants

- The endpoint is a Unix domain socket on POSIX or a Windows named pipe. TCP endpoints are rejected.
- POSIX socket parent directories are mode `0700`; the socket is created mode `0600`. An existing endpoint fails startup rather than being unlinked without daemon-identity verification.
- A client must send an `authenticate` frame carrying the host-private daemon credential before it can issue a request. Credentials are never logged or returned.
- Frames are LF-delimited JSON. They have a 1 MiB maximum buffered size. A malformed, oversized, unauthenticated, or invalid request closes the connection.
- The current spike supports `runtime.health` and `sessions.prompt`. It maps text/thinking deltas, tool lifecycle, queue changes, and agent lifecycle to the canonical event names in `docs/pichamber-pi-workstream-0.md`.
- Each event and reconnect snapshot has a monotonic sequence. A reconnect receives `session.snapshot`; unavailable runtimes are not represented as empty sessions.
- The daemon owns the runtime after clients disconnect. Disconnecting the web-server client cannot stop active Pi work.

## Deliberate limits

This is a focused architecture spike, not a public API or UI migration. It does not register `/api/pi/*` routes, start a child process, expose provider operations, or implement session registry/queue/recovery persistence. Those remain Workstreams 1–4 work.

The Pi SDK is pinned exactly at `0.84.1`. Any Pi 0.x minor upgrade requires a deliberate SDK/release-note review and repeat of this module's disposable-runtime smoke validation.
