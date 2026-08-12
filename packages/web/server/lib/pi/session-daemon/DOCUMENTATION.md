# Pi Session Daemon

## Purpose

This module is the Pi-owned session-daemon foundation. A detached local daemon process creates an `AgentSessionRuntime` with the Pi SDK, tracks it in a registry keyed by Pi session identity and cwd, keeps it behind a private local socket, and maps a small event subset to the PiChamber IPC contract. Browsers never connect to it.

## Entrypoints

- `session-daemon.js`
  - `createPiSessionRuntime({ cwd, agentDir })` creates a persistent Pi runtime using the selected server-side cwd and Pi agent directory. It uses Pi's normal settings, credentials, models, sessions, skills, prompts, and context discovery, with native extensions explicitly disabled for the core milestone.
  - `createSessionDaemon(options)` starts/stops the authenticated local socket daemon and validates its endpoint and setup inputs.
- `daemon-process.js` is the detached private-process entrypoint. It reads the daemon credential from its owner-only sidecar, starts the socket, writes non-secret identity state only after readiness, and removes only its own state on signal shutdown.
- `ipc-client.js` is the server-only authenticated request client. It owns JSONL framing and never exposes endpoint or credential values to callers.
- `runtime-registry.js` owns active runtime identities and session-local subscriptions. It rebinds the subscription after an SDK session replacement, rejects identity conflicts rather than displacing another runtime, and attempts every tracked disposal even when another disposal fails.
- `session-jsonl.js` validates the cwd-scoped Pi JSONL directory before session discovery. Pi's SDK deliberately skips malformed discovery entries; this boundary maps malformed, missing, and unreadable candidates to stable explicit failures instead of an empty result.
- `supervisor.js` resolves server-only overrides, creates the credential, serializes start/reuse/stop through an owner-only lock, validates daemon identity through `runtime.health`, forwards server-owned commands only after that identity check, and starts or stops the detached process.
- `../routes.js` registers authenticated public adapters before the generic proxy. It exposes only whitelisted runtime, project, session, and SSE event shapes; no browser response contains daemon paths, credentials, PIDs, or socket framing. Session actions are path-selected, so an identity supplied in a request body cannot redirect a mutation. `archive-store.js` persists PiChamber-only opaque session archive metadata atomically beneath the PiChamber data root and never edits Pi JSONL.
- `*.test.js` uses temporary cwd, agent, data, and runtime directories; it never loads a developer's Pi home, credentials, or sessions.

## Protocol and security invariants

- The endpoint is a Unix domain socket on POSIX or a Windows named pipe. TCP endpoints are rejected.
- POSIX socket parent directories are mode `0700`; the socket is created mode `0600`. An existing endpoint fails startup rather than being unlinked without daemon-identity verification.
- The daemon credential and non-secret state sidecars are mode `0600`; their PiChamber parent directory and the operation lock serialize start/reuse/stop. Health identity includes the daemon PID and must match the state sidecar before the supervisor reuses or signals a process.
- The public health route deliberately whitelists its response fields. It never returns a daemon endpoint, credential, PID, cwd, agent directory, or transcript data.
- A client must send an `authenticate` frame carrying the host-private daemon credential before it can issue a request. Credentials are never logged or returned.
- Frames are LF-delimited JSON. They have a 1 MiB maximum buffered size. A malformed, oversized, unauthenticated, or invalid request closes the connection.
- The private core commands are `runtime.health`, `projects.list/select`, and session list/create/open/rename/delete/tree/navigate/fork/clone/prompt/steer/followUp/abort/model/thinking/compact operations. `sessions.list` revalidates the configured cwd's JSONL directory before SDK discovery, rejects a different requested directory, and returns no JSONL paths. Session selection validates a persisted JSONL path before Pi opens it; inactive mutations are never directed by a browser-supplied path. The daemon maps Pi message lifecycle, deltas, tools, queue changes, model/thinking, compaction, and interruption state to canonical events.
- Each event and reconnect snapshot has a monotonic sequence. A reconnect receives `session.snapshot`; unavailable runtimes are not represented as empty sessions.
- Registry keys combine the SDK session ID with its cwd. A replacement subscription is rebound to the replacement session so old-session events cannot be published under the new identity. A collision is a visible error; it never replaces or disposes an unrelated runtime.
- After `agent_settled`, the daemon disposes an idle runtime after five minutes (injectable for tests). Disposal never deletes Pi JSONL; the daemon remembers the selected session file and recreates that runtime on the next private prompt. A new agent start cancels a pending disposal.
- A startup validation failure writes only a stable failure code to the owner-only non-secret state sidecar. It never records a transcript, session path, or credential. The supervisor surfaces that code as unavailable instead of claiming an empty or idle session.
- After a forced crash, the supervisor removes an existing POSIX socket only when its recorded daemon PID is dead, the endpoint is a socket, and the endpoint is unreachable through the authenticated client. An endpoint that responds or cannot be classified remains `DAEMON_ENDPOINT_UNVERIFIED`.
- The daemon owns the runtime after clients disconnect. Disconnecting the web-server client cannot stop active Pi work.

## Deliberate limits

This module defines the authenticated session API boundary, not the UI migration. Provider, resource, and attachment handlers remain owned by their later configuration/resource/attachment work; their names are reserved in the public contract but are not advertised as daemon capabilities. The session event stream is SSE over the existing authenticated runtime transport; WebSocket callers fall back to it, preserving direct and relay behavior without a second daemon listener.

The Pi SDK is pinned exactly at `0.84.1`. Any Pi 0.x minor upgrade requires a deliberate SDK/release-note review and repeat of this module's disposable-runtime smoke validation.
