# Client Auth Module Documentation

## Purpose

This module owns the trusted-device credential store and the live lifetime of
credentials that the UI auth gate accepts: client bearer tokens
(`oc_client_…`) and the principals they resolve to. Password, passkey, and
Pairing v2 are issuance methods (see `../ui-auth/DOCUMENTATION.md`); this
module owns storage, authentication, revocation, and — since live credential
revocation (#9) — the closing of established connections when a credential is
revoked or globally invalidated.

## Files

- `remote-clients.js`: trusted-device client token storage (hashed tokens,
  atomic writes, cross-process file lock), bearer authentication, last-used
  tracking, relay-demand signals, revocation, and principal validation.
- `pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption
  into trusted-device client tokens.
- `principal-tracker.js`: live connection tracking by principal plus the
  revocation coordinator that closes tracked connections on revocation.

## Principal model

A principal is derived from verified credentials at the auth-owning boundary
(`uiAuthController.requireAuth` / `ensureSessionToken`), never from anything a
client supplies:

- `client:<id>` — a remote-client bearer token resolved through the hashed
  token store.
- The raw UI session JWT — a browser session authenticated by its cookie.
- Opaque session tokens in passwordless mode (no credential store; no
  revocation concept).

## Live credential revocation (#9)

Revoking a credential must do more than mark the store record. Four

deterministic barriers cover mint, auth, track, and upgrade:

1. **Deny new establishment (mint/auth).** Bearer authentication fails on the
   revoked record (`authenticateBearerToken`), so mints and API calls fail at
   once.
2. **Deny already-minted URL tokens (mint/open race).** The encrypted
   `oc_url_token` embeds the principal, so establishment re-validates it
   against the store (`isClientValid`) and the current signing secret
   (`verifySessionToken`). A URL token minted moments before revocation or
   global sign-out is refused at open time even though its 60-second TTL has
   not elapsed.
3. **Close established connections.** The coordinator closes the tracked
   connections of the revoked principal. Applies to SSE event streams
   (`/api/pi/events`) and the terminal (`/api/terminal/ws`) and dictation
   (`/api/stt/ws`) WebSocket upgrades over direct connections. Relayed traffic
   reaches the same server-side gates (the tunnel host dials loopback and
   presents the loopback origin); the `x-pichamber-relay-connection` header is
   transport classification only. A header-marked direct request is NOT a true
   tunnel — see Verification below.
4. **Reject late registration (verify-registration race, track/upgrade).**
   Bearer/URL validation awaits the store and the WebSocket path additionally
   awaits the origin gate, so a revocation can commit+close between
   verification and registration. The coordinator remembers every in-process
   revocation (`revokedClientIds`, bounded FIFO, default 2000) and a monotonic
   global generation (bumped by every `revokeAllLive()`). `trackLiveConnection`
   checks both synchronously — revoked-ID match reject-closes with
   `close('credential-revoked')`, stale-generation match reject-closes with
   `close('global-invalidation')` — without trusting the caller's principal.
   The synchronous check+insert is atomic, so no in-process revoke slips
   between them. Auth boundaries capture `getGeneration()` BEFORE their first
   await (SSE in `requireAuth`, WebSocket in the upgrade handler before
   `ensureSessionToken`/origin) and pass it at track time; WebSocket upgrades
   with an inactive entry (`active === false`) must skip `handleUpgrade` (the
   socket is already destroyed).

### URL-token expiry vs connection lifetime

The 60-second URL token TTL gates **establishment only**. It is never a
connection lifetime grant: an established SSE stream or WebSocket is governed
by live revocation tracking, not by token expiry, and connections are not
closed when their mint token ages out.

### Latency guarantee (healthy storage only)

- **In-process revocation** (the `DELETE /api/client-auth/clients/:id` route
  and global sign-out `/auth/reset`): the store write commits, then
  `clientRevoked()` / `revokeAllLive()` closes the tracked connections
  synchronously inside the revoking request. No timers are involved; the
  response reports `closedConnections`.
- **Cross-process propagation**: the credential store is a file shared by
  processes using the data directory (one server plus the
  `pichamber connect-url` pairing CLI, which shares only
  `remote-clients.json`). No cross-process revocation emitter exists, and none
  is claimed. Propagation is a **bounded poll** of `listRevokedClientIds()`
  (default every 15 seconds, timer unref'd); a revocation committed by another
  process therefore closes this process's tracked connections within one poll
  interval **after the next successful poll**. A failed poll tick provides no
  guarantee — it is transient (current state kept, next tick retries, never an
  authoritative empty result), but while polls fail, already-established
  cross-process connections are retained (degraded retention). New
  bearer/URL-token establishment stays authoritatively gated by direct
  store/secret reads and is unaffected by poll health.

### Topology

One server process per data directory. The pairing CLI never rotates the JWT
secret, so browser-session rotation (`/auth/reset`) is in-process only and has
no cross-process poll. Multi-server sharing of one data directory is not
supported.

### Scope boundary

Cloudflare-tunnel sessions are a separate credential system owned by
`../server/tunnel-auth.js`; their established-connection semantics are not
managed by this tracker. Revoking a remote client never touches other
clients' connections or Pi daemon work: closing one SSE connection tears down
only that client's daemon subscription through the normal disconnect path.

### Global invalidation (sign-out everywhere)

`/auth/reset` rotates the JWT secret — invalidating every outstanding UI
session JWT and URL token from then on — and calls `revokeAllLive()` so all
tracked established connections (client and session principals, SSE and
WebSocket) end immediately. New cookies and URL tokens are issued from the
reread in-memory secret, so they bind to the new generation. While
`PICHAMBER_JWT_SECRET` is set, rotation is impossible and `/auth/reset`
returns 400 without side effects (no live close, no passkey clear) — closing
live connections while leaving the secret valid would imply a sign-out that
never happened.

### Resource bounds

- `MAX_LIVE_CONNECTIONS_PER_PRINCIPAL = 50`, `MAX_LIVE_CONNECTIONS_GLOBAL =
  1000`: a new registration beyond either bound is reject-closed synchronously
  with `close('over-limit')` without evicting unrelated entries. Memory is
  O(global) entries (each a small id/principal/closure triple).
- `MAX_REMEMBERED_REVOKED_CLIENTS = 2000`: revoked-ID memory for the
  verify-registration barrier is a bounded FIFO; beyond it the oldest ID is
  evicted and falls back to establishment-time store checks plus the next
  poll.
- After `dispose()` (shutdown) every new registration is reject-closed with
  `close('shutdown')`.

## Tracking lifecycle and cleanup

- Connections are tracked only after all auth/origin gates pass, and before
  the transport is handed to the route (SSE) or the WebSocket upgrade
  (`handleUpgrade`), so the pending window is covered: a revocation racing a
  still-opening connection destroys it. The generation is captured before the
  first auth/origin await; track rejects stale generations and revoked IDs
  synchronously, and WebSocket upgrades skip `handleUpgrade` for inactive
  entries.
- Entries are removed when the transport ends by itself (`res.once('close')`
  for SSE, `socket.once('close')` for upgrades — this also covers failed
  upgrades), so the index never accumulates dead entries.
- `close` callbacks are synchronous destroys wrapped idempotently; a failing
  close is isolated (reported via `onCloseError`) and cannot strand other
  connections. Reject-close paths (`over-limit`, `credential-revoked`,
  `global-invalidation`, `shutdown`) use the same isolation.
- Shutdown: `dispose()` stops the poll timer and closes remaining tracked
  connections synchronously (bounded cleanup); later registrations are
  reject-closed. The terminal/STT runtimes' own shutdown terminates their
  sockets through their normal paths.
- Revoke/self-revoke authorization (which caller may revoke which ID) is
  enforced at the core route; the tracker keys off the store-derived
  principal only and never trusts a caller-supplied ID.

## Verification

```sh
bun test packages/web/server/lib/client-auth/principal-tracker.test.js
bun test packages/web/server/lib/ui-auth/ui-auth.test.js
bun test packages/web/server/lib/client-auth/live-revocation.test.js
```

`live-revocation.test.js` exercises the real auth and origin gates (no
stubbed upgrades) with synthetic credentials over direct and
relay-classified SSE (header only — NOT a true tunnel), terminal and
dictation WebSocket upgrades with trusted/untrusted origins, another-device
isolation, the verify-registration race during the origin gate, the
cross-process second-runtime revocation, and shutdown cleanup. A disposable
true-tunnel integration dispatches authenticated HTTP through
`createTunnelHost` to loopback, proving bearer auth and loopback-origin
overwrite with the real gate. Gap: tunneled WebSocket upgrades and long-lived
SSE streaming through the tunnel reuse the same server-side gates but have no
disposable integration here.
