# PiChamber Pi Migration: Workstream 1 Daemon Lifecycle Record

## Status and scope

This record covers the initial daemon-lifecycle implementation following the completed boundary and SDK spike in [the Workstream 0 record](./pichamber-pi-workstream-0.md). It makes the private Pi runtime independently supervised by the web server and exposes only authenticated public health. It is not a session/UI cutover and does not create a supported OpenCode/Pi runtime choice.

## Implemented ownership

| Surface | Implementation | Rationale |
| --- | --- | --- |
| Private process | `packages/web/server/lib/pi/session-daemon/daemon-process.js` | A detached local process owns the SDK runtime, so a browser disconnect and a web-server restart do not automatically dispose active Pi work. |
| Server supervision | `supervisor.js` | The web server resolves local endpoint/data paths, serializes start/reuse/stop, health-checks an existing daemon before reuse, starts the private process when absent, and signals only a health-identity-matched daemon on shutdown. |
| Private client | `ipc-client.js` | The server reaches the daemon with its local credential over JSONL IPC. The module owns framing/timeouts and gives callers stable errors rather than an empty runtime result. |
| Public health adapter | `packages/web/server/lib/pi/routes.js` | `GET /api/pi/runtime` is registered before the generic OpenCode proxy and returns only `protocolVersion`, `state`, `capabilities`, or a stable unavailable error code. It never returns endpoint, key, PID, cwd, agent directory, or session data. |
| Web lifecycle | `packages/web/server/index.js` | The server starts the daemon after its listener is ready and attempts a graceful daemon stop before HTTP shutdown. A startup failure leaves the route available with `503`/`DAEMON_*`, not a fabricated idle or empty response. |

## Local files and permissions

All paths are server-only. Browser clients neither receive nor construct them.

| Item | Path | Rule |
| --- | --- | --- |
| POSIX endpoint | `$XDG_RUNTIME_DIR/pichamber/pi-session-daemon.sock`, or `$OPENCHAMBER_DATA_DIR/runtime/pi-session-daemon.sock` | Parent is `0700`; socket is `0600`. TCP is rejected. |
| Windows endpoint | `\\.\pipe\pichamber-pi-session-daemon-<owner-key>` | Named-pipe endpoint only; credential authentication remains mandatory. Windows ACL enforcement needs a dedicated platform implementation before claiming equivalent owner-only OS permissions. |
| Credential | `$OPENCHAMBER_DATA_DIR/pi/session-daemon.key` | 32 random bytes encoded as hex, created/read `0600`; passed by file access, never command line, public response, or logs. |
| State | `$OPENCHAMBER_DATA_DIR/pi/session-daemon-state.json` | `0600`; non-secret protocol, PID, endpoint, and start-time metadata written only after daemon readiness. |
| Operation lock | `$OPENCHAMBER_DATA_DIR/pi/session-daemon.lock` | `0600`; `wx` claim serializes start/reuse/stop. A stale claim is removed only after its PID is no longer alive. |

An existing socket that cannot be authenticated and matched to the state PID is never removed automatically. The supervisor reports `DAEMON_ENDPOINT_UNVERIFIED`, preserving safety over speculative cleanup.

## Runtime behavior

- The supervisor honors `OPENCHAMBER_DATA_DIR`, `OPENCHAMBER_PI_AGENT_DIR`, and `OPENCHAMBER_PI_SESSION_DAEMON_ENDPOINT` only on the server.
- The Pi runtime now uses `SessionManager.create(cwd)` without overriding Pi's default session directory, preserving Pi's normal cwd-scoped session discovery.
- The private health response includes a daemon PID only for supervisor identity verification. The public adapter strips it.
- The server's existing authenticated `/api` middleware protects `/api/pi/runtime`; the adapter is registered before the generic OpenCode `/api/*` proxy.
- Shutdown is best-effort only after the same private health/identity verification. It cannot signal an arbitrary PID from a stale sidecar.

## Deliberate limits

This foundation still has one active runtime/session in the daemon. It does not yet implement the Workstream 1 registry and directory-scoping responsibilities, Pi session list/create/open/delete/tree/fork/clone operations, session replacement rebinding, idle runtime disposal, malformed-JSONL reporting, queue policy, replay persistence, or forced-crash interruption/recovery. The only public Pi route is runtime health; session routes and public event streaming are later contract work.

## Validation evidence

Focused tests use temporary PiChamber data roots, XDG runtime directories, project directories, and Pi agent directories with `PI_OFFLINE=1`. They verify real detached daemon start/reuse/health/stop, sidecar key mode, no secret in health output, socket authentication/reconnect behavior, and public health response redaction/unavailable status. They do not exercise Windows pipe ACLs, a live model provider, full server startup, or the deferred registry/recovery operations.
