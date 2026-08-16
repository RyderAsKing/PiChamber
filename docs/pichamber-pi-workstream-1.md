# PiChamber Pi Migration: Workstream 1 Daemon Lifecycle Record

## Status and scope

This record covers the completed daemon-lifecycle work following the boundary and SDK spike in [the Workstream 0 record](./pichamber-pi-workstream-0.md). It makes the private Pi runtime independently supervised by the web server, records active runtimes by authoritative Pi identity plus cwd, and exposes only authenticated public health. It is not a session/UI cutover and does not create a supported OpenCode/Pi runtime choice.

## Implemented ownership

| Surface | Implementation | Rationale |
| --- | --- | --- |
| Private process | `packages/web/server/lib/pi/session-daemon/daemon-process.js` | A detached local process owns the SDK runtime, so a browser disconnect and a web-server restart do not automatically dispose active Pi work. |
| Server supervision | `supervisor.js` | The web server resolves local endpoint/data paths, serializes start/reuse/stop, health-checks an existing daemon before reuse, starts the private process when absent, and signals only a health-identity-matched daemon on shutdown. |
| Private client | `ipc-client.js` | The server reaches the daemon with its local credential over JSONL IPC. The module owns framing/timeouts and gives callers stable errors rather than an empty runtime result. |
| Public health adapter | `packages/web/server/lib/pi/routes.js` | `GET /api/pi/runtime` is registered before the generic OpenCode proxy and returns only `protocolVersion`, `state`, `capabilities`, or a stable unavailable error code. It never returns endpoint, key, PID, cwd, agent directory, or session data. |
| Web lifecycle | `packages/web/server/index.js` | The server starts the daemon after its listener is ready and attempts a graceful daemon stop before HTTP shutdown. A startup failure leaves the route available with `503`/`DAEMON_*`, not a fabricated idle or empty response. |
| Runtime registry and idle lifecycle | `packages/web/server/lib/pi/session-daemon/runtime-registry.js`, `session-daemon.js` | Active SDK runtimes use `{ cwd, sessionId }` identity. Replacement detaches the old listener before binding the new session; duplicate ownership is rejected. An `agent_settled` runtime is disposed after the daemon's five-minute idle timeout, without deleting Pi JSONL, and is recreated from the remembered session file on the next private prompt. |
| JSONL validation and crash recovery | `session-jsonl.js`, `daemon-process.js`, `supervisor.js` | The daemon validates every cwd-scoped Pi JSONL candidate rather than accepting Pi discovery's best-effort omission. Malformed/unreadable files produce stable failure codes in the owner-only state sidecar. After a forced crash, the supervisor removes a stale POSIX socket only after the recorded PID is dead and the socket is unreachable through the authenticated client. |

## Local files and permissions

All paths are server-only. Browser clients neither receive nor construct them.

| Item | Path | Rule |
| --- | --- | --- |
| POSIX endpoint | `$XDG_RUNTIME_DIR/pichamber/pi-session-daemon.sock`, or `$PICHAMBER_DATA_DIR/runtime/pi-session-daemon.sock` | Parent is `0700`; socket is `0600`. TCP is rejected. |
| Windows endpoint | `\\.\pipe\pichamber-pi-session-daemon-<owner-key>` | Named-pipe endpoint only; credential authentication remains mandatory. Windows ACL enforcement needs a dedicated platform implementation before claiming equivalent owner-only OS permissions. |
| Credential | `$PICHAMBER_DATA_DIR/pi/session-daemon.key` | 32 random bytes encoded as hex, created/read `0600`; passed by file access, never command line, public response, or logs. |
| State | `$PICHAMBER_DATA_DIR/pi/session-daemon-state.json` | `0600`; non-secret protocol, PID, endpoint, and start-time metadata written only after daemon readiness. |
| Operation lock | `$PICHAMBER_DATA_DIR/pi/session-daemon.lock` | `0600`; `wx` claim serializes start/reuse/stop. A stale claim is removed only after its PID is no longer alive. |

An existing socket that cannot be authenticated and matched to the state PID is never removed automatically. The supervisor reports `DAEMON_ENDPOINT_UNVERIFIED`, preserving safety over speculative cleanup.

## Runtime behavior

- The supervisor honors `PICHAMBER_DATA_DIR`, `PICHAMBER_PI_AGENT_DIR`, and `PICHAMBER_PI_SESSION_DAEMON_ENDPOINT` only on the server.
- The Pi runtime resolves its cwd-scoped session directory from the configured Pi agent directory, preserving Pi's normal `sessions/<encoded-cwd>` discovery layout while honoring the server-only agent override.
- The private health response includes a daemon PID only for supervisor identity verification. The public adapter strips it.
- A valid owner-only failure sidecar makes health explicitly unavailable with `MALFORMED_SESSION_JSONL` or `SESSION_JSONL_UNREADABLE`; it never becomes an empty session list or synthetic idle state.
- The server's existing authenticated `/api` middleware protects `/api/pi/runtime`; the adapter is registered before the generic OpenCode `/api/*` proxy.
- Shutdown is best-effort only after the same private health/identity verification. It cannot signal an arbitrary PID from a stale sidecar.

## Deliberate limits

The daemon currently restores only the single last-active runtime after idle disposal. Pi session collection/mutation commands, queue policy, replay persistence, session routes, and public event streaming are later IPC/API work. The only public Pi route remains runtime health.

## Validation evidence

Focused tests use temporary PiChamber data roots, XDG runtime directories, project directories, and Pi agent directories with `PI_OFFLINE=1`. They verify real detached daemon start/reuse/health/stop, sidecar key mode, no secret in health output, socket authentication/reconnect behavior, identity-plus-cwd registry rebinding/conflict behavior, idle disposal without JSONL deletion and rehydration, malformed/unreadable JSONL failures, forced-`SIGKILL` crash recovery, and public health response redaction/unavailable status. They do not exercise Windows pipe ACLs, a live model provider, full server startup, or future IPC/API commands.
