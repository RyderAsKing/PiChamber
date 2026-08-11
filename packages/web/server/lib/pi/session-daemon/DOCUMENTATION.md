# Pi Session Daemon

## Purpose

This module is the Pi-owned session-daemon foundation. A detached local daemon process creates one `AgentSessionRuntime` with the Pi SDK, keeps it behind a private local socket, and maps a small event subset to the PiChamber IPC contract. Browsers never connect to it.

## Entrypoints

- `session-daemon.js`
  - `createPiSessionRuntime({ cwd, agentDir })` creates a persistent Pi runtime using the selected server-side cwd and Pi agent directory. It uses Pi's normal settings, credentials, models, sessions, skills, prompts, and context discovery, with native extensions explicitly disabled for the core milestone.
  - `createSessionDaemon(options)` starts/stops the authenticated local socket daemon and validates its endpoint and setup inputs.
- `daemon-process.js` is the detached private-process entrypoint. It reads the daemon credential from its owner-only sidecar, starts the socket, writes non-secret identity state only after readiness, and removes only its own state on signal shutdown.
- `ipc-client.js` is the server-only authenticated request client. It owns JSONL framing and never exposes endpoint or credential values to callers.
- `supervisor.js` resolves server-only overrides, creates the credential, serializes start/reuse/stop through an owner-only lock, validates daemon identity through `runtime.health`, and starts or stops the detached process.
- `../routes.js` registers the authenticated public `GET /api/pi/runtime` adapter. It returns only protocol/state/capabilities or a stable unavailable code.
- `*.test.js` uses temporary cwd, agent, data, and runtime directories; it never loads a developer's Pi home, credentials, or sessions.

## Protocol and security invariants

- The endpoint is a Unix domain socket on POSIX or a Windows named pipe. TCP endpoints are rejected.
- POSIX socket parent directories are mode `0700`; the socket is created mode `0600`. An existing endpoint fails startup rather than being unlinked without daemon-identity verification.
- The daemon credential and non-secret state sidecars are mode `0600`; their PiChamber parent directory and the operation lock serialize start/reuse/stop. Health identity includes the daemon PID and must match the state sidecar before the supervisor reuses or signals a process.
- The public health route deliberately whitelists its response fields. It never returns a daemon endpoint, credential, PID, cwd, agent directory, or transcript data.
- A client must send an `authenticate` frame carrying the host-private daemon credential before it can issue a request. Credentials are never logged or returned.
- Frames are LF-delimited JSON. They have a 1 MiB maximum buffered size. A malformed, oversized, unauthenticated, or invalid request closes the connection.
- The current spike supports `runtime.health` and `sessions.prompt`. It maps text/thinking deltas, tool lifecycle, queue changes, and agent lifecycle to the canonical event names in `docs/pichamber-pi-workstream-0.md`.
- Each event and reconnect snapshot has a monotonic sequence. A reconnect receives `session.snapshot`; unavailable runtimes are not represented as empty sessions.
- The daemon owns the runtime after clients disconnect. Disconnecting the web-server client cannot stop active Pi work.

## Deliberate limits

This is not a session/UI migration. `GET /api/pi/runtime` is the only public adapter and the daemon still has one runtime/session rather than a directory-scoped registry. It does not expose project/session collection operations, provider operations, queue policy, replay persistence, or recovery after a forced daemon crash. Those remain later daemon and API work.

The Pi SDK is pinned exactly at `0.84.1`. Any Pi 0.x minor upgrade requires a deliberate SDK/release-note review and repeat of this module's disposable-runtime smoke validation.
