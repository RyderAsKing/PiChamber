# Tailscale Module Documentation

## Purpose

Tailscale remote access for PiChamber: `tailscale serve` publishes the local
server at `https://<machine>.<tailnet>.ts.net[:port]`, reachable only by
devices in the user's tailnet (private). `tailscale funnel` is identical but
reachable from the public internet (public). Funnel only allows the HTTPS
ports 443, 8443 and 10000. The URL is the machine's MagicDNS name and does
not change when the mapping is removed and re-added.

Off by default. Enabled only via the settings API (`PUT
/api/pichamber/tailscale/config`) or CLI flags (`pichamber pair --tailscale`,
`pichamber serve --tailscale`). Never auto-enabled when Tailscale is
detected.

Ephemeral Cloudflare quick tunnels were removed; this module is unaffected.

## Entrypoints and structure

- `tailscale.js`: pure helpers — config validation/normalization, the auth
  gate, executable resolution, `status --json` parsing (trailing-dot DNSName,
  `BackendState`, `CertDomains`), `serve status --json` conflict detection,
  approval-URL extraction, permission-denied detection. No I/O.
- `service.js`: `createTailscaleService` — persisted config, lifecycle
  (apply on start, remove on stop, reconcile on change), crash-safe mapping
  record, probe-before-advertise, approval wait, and the status model. All
  process execution goes through the injected `runner` (argument arrays, no
  shell, bounded timeouts); tests inject a fake.
- `routes.js`: `registerTailscaleRoutes` — thin authenticated HTTP API
  following the `/api/pichamber/tunnel/*` conventions.
- `tailscale.test.js`: unit tests with an injected fake runner.

## Lifecycle ("while PiChamber runs")

1. `startWebUiServer` loads the persisted config, then reconciles the mapping
   **after** HTTP listen to `http://127.0.0.1:<boundPort>` — always loopback,
   even when the server also binds LAN. Reconcile runs in the background so
   an approval wait never blocks server-ready (status shows
   starting/needs-approval meanwhile); rejections are caught and logged.
   Apply failure logs a warning and never stops startup; the status model
   carries the error and `POST /api/pichamber/tailscale/retry` (or any
   config change) reconciles again.
2. Runtime config changes reconcile: abort the in-flight apply (generation
   bump kills it), remove the old mapping, apply the new one (bounded
   timeouts). A superseded apply that still created a mapping is verified
   and removed, so no mapping is left unowned.
3. Graceful shutdown (`controller.stop`, covering CLI serve stop, SIGINT,
   SIGTERM, and the Electron in-process server stop path) removes the mapping
   PiChamber created (`serve/funnel --https=<p> off`, as appropriate) — but
   only after verifying ownership against live serve status. On a status
   query failure nothing is removed and the record is kept, so the next
   start's stale cleanup retries with verification. Electron awaits this
   stop with a bounded quit timeout before exiting. Removal failure logs a
   warning and never blocks shutdown.

## Crash safety and conflict rules

- The mapping PiChamber created is recorded in `tailscale-mapping.json`
  (`{ httpsPort, mode, localPort }`) in the PiChamber data dir. On the next
  start, a stale record for a different port/mode is removed (when it is
  ours) before the new mapping is applied; a disabled config removes a stale
  own mapping and reports `off`; a `blocked` (auth-gate) config removes a
  stale own mapping first and then reports `blocked` (tailscaled persists
  serve config, so the mapping would otherwise stay reachable without
  auth). A failed status query keeps the record and reports `error` with
  code `status_query_failed` (retry available) instead of acting blind.
- NEVER remove or overwrite a mapping PiChamber did not create. Before
  applying, `tailscale serve status --json` (`funnel status --json` for
  public) is inspected — `Web` entries keyed by `<host>:<port>` with handler
  targets. A mapping is OURS only when every handler target points at our
  own `http://127.0.0.1:<boundPort>`. Anything else on the target port
  reports state `conflict` with code `conflict` and a message suggesting the
  other ports (8443/10000).

## Security gate (core-enforced)

Tailscale proxies requests to loopback, which bypasses the
"refuse a network-exposed bind without a UI password" rule. Enabling
Tailscale (either mode) therefore requires UI auth (a UI password):

- Enforced in `setConfig` (rejects with code `auth_required`), in
  `persistTailscaleConfigForStartup` (same gate, so the CLI cannot persist
  an enabled config without satisfying it either), in server startup
  reconcile (config enabled but gate unsatisfied → existing own mapping
  removed with ownership verification, then state `blocked`, code
  `auth_required`, mapping not applied), and in `pichamber serve
  --tailscale` (fast deterministic CLI failure).
- `private` mode honors the same `PICHAMBER_ALLOW_UNAUTHENTICATED_LAN`
  escape hatch as a LAN bind (`true`/`1`, case-insensitive). `public` mode
  has NO escape hatch.

With no UI password, the Tailscale status/config routes are reachable
unauthenticated on loopback/LAN — the same as every other route in that
mode (no per-route auth exists without a password); enabling/disabling is
fail-safe because the auth gate above rejects enabling.

Funnel traffic is classified as `local` request scope by tunnel-auth
`classifyRequestScope` (it arrives from the loopback socket with a
forwarded Host). `local` scope is transport classification only and must
never relax authentication.

## Trust-proxy / rate-limit / cookie / passkey findings

The server runs with `app.set('trust proxy', true)` (intentional: reverse
proxies and tunnels terminate TLS and set `X-Forwarded-*`).

- **Rate limiting (`getClientIp`)**: login limiters (UI password/passkey in
  `ui-auth.js`, `/connect` in `tunnel-auth.js`) use a DUAL bucket. The
  per-client bucket is still keyed by `X-Forwarded-For` first (UX behind
  legit proxies: each tailnet device keeps its own budget), but EVERY
  attempt is ALSO counted against a socket-address bucket keyed by
  `req.socket.remoteAddress` (never `req.ip`, which Express rewrites from
  XFF under `trust proxy`). The socket bucket allows 5x the per-client
  limit in the same window — headroom for one forwarder multiplexing many
  clients — and an attempt is refused if EITHER bucket is exhausted.
  Threat direction: Tailscale Serve/Funnel forwards from 127.0.0.1 and
  passes attacker-supplied XFF through, so XFF alone is attacker-controlled
  and must never be the only key. Rotating XFF from one socket now hits the
  socket lockout (50 login / 100 connect attempts per 5 minutes), and
  distinct sockets stay independent.
- **Pairing redeem limiter**: keyed by the socket address (deliberately NOT
  `req.ip`), so all Tailscale traffic shares the `127.0.0.1` bucket: 10
  attempts per 5 minutes per `pairingId`. Pairing-ID scoping keeps this a
  per-link budget, so one attacker's guesses never consume another link's
  budget. Kept as-is; documented here.
- **Secure cookies (`isSecureRequest`)**: trusts `X-Forwarded-Proto`. Tailscale
  terminates TLS and forwards `https`, so session cookies stay `Secure` over
  the ts.net URL. If the header were absent, cookies would be issued without
  the Secure flag but still over the encrypted tailnet transport — no
  downgrade to plaintext.
- **Passkeys (`getCurrentRpId`)**: the relying-party ID derives from the
  request host, so passkeys registered over the ts.net hostname are scoped to
  that hostname and do not collide with LAN-host passkeys. No change needed.
- **Origin checks**: tunneled requests carry the ts.net origin via
  `Host`/`X-Forwarded-Host`; no ts.net-specific origin bypass was added.

Nothing above required a code change: the gates already treat Tailscale as an
untrusted network transport, and the `auth_required` gate closes the
loopback-proxies-bypass-auth hole.

## Status model (shared with the UI wrapper in `packages/ui/src/lib/tailscale.ts`)

`{ installed, running /* BackendState Running */, loggedIn, magicDnsName,
httpsCertsAvailable /* from CertDomains when present, else null */,
config: { enabled, mode, httpsPort }, state, url, approvalUrl, errorCode,
errorMessage, authGate: { privateAllowed, publicAllowed } }`

`authGate` is computed with `checkTailscaleAuthGate` for each mode: private
may stay allowed via `PICHAMBER_ALLOW_UNAUTHENTICATED_LAN`, public never is.
The UI disables each mode individually from these flags before the user
clicks, instead of waiting for the 403 from `setConfig`.

States: `off` | `unavailable` (not installed/running/logged in) | `blocked`
(auth gate) | `starting` (applied, URL not yet verified) |
`needs-approval` (+ `approvalUrl`) | `active` (+ `url`) | `conflict` |
`error`. `url` is set ONLY after a credential-free probe of `<url>/health`
reports this server's `serverId` (the persisted stable identity in
`server-identity.json`, also exposed on `/health` and `/api/version` so
clients verify a learned address BEFORE sending a bearer token). First-time
Funnel DNS can take minutes: `starting` keeps re-probing with backoff for up
to ~10 minutes.

Error codes: `auth_required` | `not_installed` | `not_running` |
`not_logged_in` | `permission_denied` (`sudo tailscale set --operator=$USER`)
| `needs_approval` | `conflict` | `apply_failed` | `status_query_failed`
(retry available; nothing was changed) | `probe_failed` | `invalid_config` |
`timeout` | `unknown`.

## Approval flow

When HTTPS certs or Funnel are not enabled for the tailnet, serve/funnel
prints `https://login.tailscale.com/f/serve?node=...` (or `/f/funnel?...`)
and may block. The service streams stdout/stderr, extracts the first approval
URL, reports `needs-approval` while it keeps waiting (bounded 5 minutes,
cancellable on config change/shutdown), then proceeds. A timeout or exit with
the URL still pending stays `needs-approval` so the operator can approve and
hit retry.

## Platform notes

- Executable: `tailscale` on PATH; macOS fallback
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; Windows
  `tailscale.exe` on PATH then `%ProgramFiles%\Tailscale\tailscale.exe`.
- Linux non-root without operator rights fails with access/permission style
  errors → code `permission_denied` with the operator fix hint.
- Tailscale is not installed in CI/dev here; runtime validation against real
  Tailscale is out of scope. The service is fully covered by fake-runner unit
  tests instead.

## Pairing integration

When `active`, the service exposes `{ type: 'tailscale', url, mode,
priority: 20 }` via `getPairingCandidate()`. Server routes append it to
Pairing v2 payloads and `GET /api/client-auth/connection/candidates` after
LAN candidates (priority 10) and before the relay candidate (priority 30).
`tailscale` is a distinct candidate type: old parsers drop unknown types
(verified in `connectionPayload.ts` and Electron `main.mjs`), so old clients
ignore it and use the rest; new desktop/mobile clients redeem over its `url`
like any direct URL. There is no per-transport "connected via" label surface
today, so no label change was needed.

## Verification

```sh
bun run test -- server/lib/tailscale/tailscale.test.js
node --check packages/web/server/lib/tailscale/service.js
```
