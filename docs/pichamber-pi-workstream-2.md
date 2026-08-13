# PiChamber Pi Migration: Private IPC and Public API Contract

## Status and scope

This record covers the completed private Pi daemon protocol and authenticated
public Pi API contract. The browser accesses only `/api/pi/*`; the web server
translates those requests to the daemon's authenticated local IPC endpoint.
The protocol is PiChamber-owned and is not Pi RPC or Pi's experimental remote
protocol.

## Implemented contract

- `packages/web/server/lib/pi/session-daemon/ipc-client.js` owns versioned
  JSONL request/response framing and daemon authentication.
- `packages/web/server/lib/pi/session-daemon/session-daemon.js` owns daemon
  command dispatch, one-active-run queueing, sequenced event publication, and
  bounded event replay.
- `packages/web/server/lib/pi/routes.js` registers authenticated `/api/pi/*`
  adapters before the former generic runtime proxy. It projects only
  browser-safe fields and maps unavailable or malformed daemon state to an
  explicit error response.
- `packages/ui/src/lib/pi/{protocol,transport,reconnect}.ts` own the public
  protocol types, authenticated runtime transport, snapshot hydration, and
  resume cursor handling.

The session contract includes project selection; session list, create, open,
rename, delete, tree, navigate, fork, clone, prompt, steer, follow-up, abort,
model, thinking, and compaction operations. Provider, resource, and attachment
commands use the same private/public boundary and retain their dedicated
ownership records.

## Invariants

- Every session event has a monotonic sequence number scoped to its session.
  Snapshots include `lastSequence`; reconnect either receives a contiguous
  replay after that cursor or an authoritative snapshot.
- The daemon enforces one active run per session. Busy-state prompt requests
  receive a stable rejection or are explicitly accepted as steering/follow-up;
  they never mutate an unrelated session.
- Public adapters authenticate before reaching daemon handlers, never expose
  daemon credentials, endpoints, PIDs, paths, request headers, or attachment
  bytes, and return unavailable/malformed state as an error rather than an
  empty result.
- The browser transport uses the shared runtime fetch and socket helpers, so
  direct, Electron, and relay-backed connections use the same authenticated
  public API. WebSocket setup falls back to SSE without changing daemon
  ownership.

## Validation evidence

Focused tests are colocated with the owning boundaries:

- `packages/web/server/lib/pi/session-daemon/session-daemon.test.js` covers
  every core session command, event-family mapping, queue/abort behavior,
  authentication, reconnect replay, and snapshots.
- `packages/web/server/lib/pi/routes.test.js` covers public authentication,
  redaction, route projections, snapshot streaming, and explicit unavailable
  or malformed collection failures.
- `packages/ui/src/lib/pi/protocol.test.ts`, `transport.test.ts`, and
  `reconnect.test.ts` cover protocol recognition, authenticated SSE/WS
  transport fallback, resume cursor handling, and unavailable/404 behavior.

The focused suites were rerun during the migration verification:

```text
bun test packages/web/server/lib/pi       65 pass, 0 fail
bun test packages/ui/src/lib/pi/          82 pass, 0 fail
```
