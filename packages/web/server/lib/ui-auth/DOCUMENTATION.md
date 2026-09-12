# UI Auth Module Documentation

## Purpose
This module owns PiChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

Browser WebSocket clients mint a 60-second `oc_url_token` through the authenticated `/auth/url-token` route because the WebSocket constructor cannot attach an Authorization header. The token is encrypted with a key derived from the server's persisted JWT secret, so an ordinary server restart does not invalidate a token that the browser may still use. Global sign-out rotates that secret and invalidates outstanding tokens. The token is accepted only for the explicit WebSocket allowlist, currently `/api/terminal/ws` and `/api/stt/ws`; ordinary API routes and unknown upgrade paths reject it. The token resolves to the UI session or remote-client identity that minted it.

The 60-second URL token TTL gates **establishment only**. Every establishment (WebSocket upgrade, SSE event-stream request) re-validates the embedded principal — client principals against the credential store, UI session principals against the current signing secret — so a token minted before a revocation or global sign-out is denied at open time (the mint/open race). An established connection's lifetime is governed by live revocation tracking, never by token expiry; see `../client-auth/DOCUMENTATION.md` for the latency guarantee (immediate in-process closure, bounded poll after the next successful read on healthy storage) and resource bounds (50 per principal / 1000 global / 2000 revoked IDs).

Verify-registration barrier: `requireAuth` captures the coordinator generation (`liveRevocation.getGeneration()`) BEFORE its first auth await and passes it to `trackLiveConnection`, so a global invalidation racing verification is rejected without trusting the principal. WebSocket upgrades capture the same generation before `ensureSessionToken`/origin and skip `handleUpgrade` for inactive entries. Per-principal revokes are covered by the coordinator's revoked-ID memory even without the generation.

Signing-secret topology: the JWT secret is read once at startup (env override or persisted file) and cached in memory; `rotateJwtSecret` rewrites the file and rereads into memory synchronously, so new cookies and URL tokens bind to the new generation. Rotation is single-server only — the pairing CLI never rotates the secret and multi-server sharing is unsupported. While `PICHAMBER_JWT_SECRET` is set, `/auth/reset` returns 400 without side effects; global sign-out is unavailable.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, auth route handlers, and the auth-owning boundary where authenticated SSE event streams are registered for live revocation.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation.
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Public exports (ui-auth.js)
- `createUiAuth({ password, cookieName, sessionTtlMs, readSettingsFromDiskMigrated, clientAuthController, requireClientAuth, liveRevocation })`: creates UI auth controller with methods:
  - `enabled`
  - `requireAuth(req, res, next)` — also registers authenticated `/api/pi/events` GET requests under their verified principal with `liveRevocation`
  - `requireSessionAuth(req, res, next)`
  - `resolveAuthContext(req, res, { allowClientAuth, allowUrlToken })`
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `handleUrlAuthToken(req, res)` — mints 60-second establishment tokens
  - `handlePasskeyStatus(req, res)`
  - `handlePasskeyRegistrationOptions(req, res)`
  - `handlePasskeyRegistrationVerify(req, res)`
  - `handlePasskeyAuthenticationOptions(req, res)`
  - `handlePasskeyAuthenticationVerify(req, res)`
  - `handlePasskeyList(req, res)`
  - `handlePasskeyRevoke(req, res)`
  - `handleResetAuth(req, res)` — global sign-out: rotates the signing secret AND closes all tracked live connections; 400 without side effects while `PICHAMBER_JWT_SECRET` is set
  - `ensureSessionToken(req, res)`
  - `dispose()`

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDiskMigrated, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`
