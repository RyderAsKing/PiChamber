# External tunnel support research

**Reviewed:** 2026-08-21  
**Scope:** Cloudflare and ngrok tunnels managed by PiChamber, plus the separate manual HTTPS and private-relay paths.

## Bottom line

PiChamber has provider adapters, a Settings page, CLI commands, profile storage, and a tunnel-auth implementation. The running Pi-native web server does not wire those pieces together, though. The tunnel routes and orchestration entrypoint are absent from the current composition root. Built-in tunnel start, status, stop, diagnostics, and connect-link generation therefore do not currently form a working product path.

There is one narrower path: `pichamber connect-url --server https://...` can advertise a manually managed HTTPS endpoint as a `tunnel` pairing candidate. That creates a pairing link; it does not start, monitor, authenticate, or stop the external provider.

There is also a provider-level compatibility problem. PiChamber's public Pi event stream is SSE-only, while Cloudflare documents that Quick Tunnels do not support SSE. Cloudflare Quick is therefore unsuitable for the live Pi UI even if the missing orchestration is restored.

## Capability matrix

| Area | Code present | What actually works today |
| --- | --- | --- |
| Cloudflare Quick | `cloudflared tunnel --url <origin>` and `*.trycloudflare.com` URL parsing in `packages/web/server/lib/cloudflare-tunnel.js` | Provider helper only. The default capability is labeled `ga` internally, but Cloudflare calls Quick Tunnels testing/development-only, with no SLA, a 200 in-flight request limit, and no SSE. |
| Cloudflare Managed Remote | `cloudflared tunnel run --token-file ...`, hostname and startup checks | Provider helper only. Requires a Cloudflare tunnel token and hostname. No PiChamber route starts it or binds its public URL to tunnel auth. |
| Cloudflare Managed Local | Reads `.yml`, `.yaml`, or `.json`, extracts an ingress hostname, then runs `cloudflared tunnel [--config path] run` | Provider helper only. PiChamber does not validate that the config's ingress points at the active PiChamber port. |
| ngrok Quick | Checks the binary and authtoken, runs `ngrok http 127.0.0.1:<port>`, reads the local API/logs for the public URL | Provider helper only. Internal capability metadata marks it `beta`. There is no managed/custom-domain ngrok mode. |
| CLI lifecycle | `pichamber tunnel providers`, `ready`, `doctor`, `status`, `start`, `stop`, and `profile ...` | Profiles, dry-runs, fallback provider listing, input validation, and output formatting work locally. Lifecycle commands call `/api/pichamber/tunnel/*` endpoints that are not registered by the current server. |
| Settings UI | Cloudflare/ngrok selector, three Cloudflare modes, TTLs, profiles, QR/connect-link display, session list, start/stop controls | The component is present, but its availability/status/start/stop requests target the same missing tunnel routes. It cannot start a tunnel against the current Pi-native server. |
| Tunnel authentication | One active tunnel, one-time bootstrap token, `/connect?t=...`, tunnel session cookie, TTLs, revocation on replacement/stop, and tunnel-scope login lock | The auth state machine is implemented but never activated. Current server wiring never calls `setActiveTunnel`, `issueBootstrapToken`, or `clearActiveTunnel`. |
| Manually managed HTTPS endpoint | `connect-url --server` creates an HTTPS candidate with `type: 'tunnel'`; clients understand direct `lan`/`tunnel` candidates | A reasonable escape hatch for a separately managed reverse proxy/provider. It is not PiChamber tunnel management, and live streaming still depends on the external proxy carrying `/api/pi/events` correctly. |
| Private relay | E2EE host/client implementation and pairing candidate code exist | Separate from external provider tunnels. Its host lifecycle is also documented as unwired in `packages/web/server/lib/relay/DOCUMENTATION.md`; it should not be counted as working external-tunnel support. |

## The main runtime gap

`packages/web/server/index.js` registers status/auth, Pi, and workspace routes, but no tunnel route module or tunnel service. The owning tunnel documentation says that the old `createTunnelService` entrypoint was removed as dead code and that the remaining files are not consumed by a tunnel orchestration runtime.

The callers still assume the old contract:

- `packages/web/bin/lib/commands-tunnel.js` requests `/api/pichamber/tunnel/check`, `/doctor`, `/providers`, `/status`, `/managed-remote-token`, `/start`, and `/stop`.
- `packages/ui/src/components/sections/pichamber/TunnelSettings.tsx` requests the same status/provider/start/stop family.
- `packages/electron/main.mjs` still probes `/api/pichamber/tunnel/status` for quit-risk confirmation, while the in-process server returns `getQuitRiskStatus() => ({ tunnel: { active: false } })`.
- `packages/web/server/index.d.ts` and the old serve parser still mention top-level tunnel options, but `startWebUiServer` does not consume them. Top-level `serve --try-cf-tunnel` was explicitly removed from the CLI contract.

This is a migration boundary, not a small provider bug. The Pi migration plan classifies Cloudflare/ngrok tunnels and the E2EE relay as later port work, and the workstream route table still describes the old tunnel route family as something to retain and port after direct Pi connections.

## Realtime compatibility

The Pi-native server exposes `GET /api/pi/events` as an SSE stream with comment heartbeats. The UI's Pi transport says the event endpoint is SSE-only and defaults to SSE. Its WebSocket branch is only usable when a runtime provides a matching upgrade endpoint; the server does not expose a Pi event WebSocket route.

Cloudflare's first-party Quick Tunnel documentation says:

- Quick Tunnels are for testing and development, not production.
- They have no SLA.
- They cap proxied requests at 200 in flight and return `429` after that limit.
- They do not support Server-Sent Events.

That means Cloudflare Quick can potentially carry ordinary HTTP requests, but it cannot carry PiChamber's authoritative live event stream. Chat tokens, tool progress, live status, and background-session updates will not be reliable through that mode. The current Settings warning mentions best-effort uptime but not the SSE incompatibility.

Cloudflare's documentation says those Quick Tunnel limitations do not apply to a normal Cloudflare Tunnel. Its managed modes are the better fit once PiChamber wires them into the server. Ngrok's first-party HTTP endpoint documentation says WebSockets work without special configuration, and ngrok also documents SSE traffic handling. The current ngrok helper uses the expected `ngrok http` endpoint, so no equivalent provider-level SSE prohibition was found for ngrok. This still needs a PiChamber end-to-end test.

The repository's reverse-proxy guide already calls out long-lived streams and disabled buffering, but its examples still use removed OpenCode paths such as `/api/event` and `/api/global/event`; it does not document the Pi-native `/api/pi/events` route.

## Security and lifecycle readiness

The intended tunnel auth design is good on paper: a one-time `/connect?t=` bootstrap token becomes an `HttpOnly` tunnel-session cookie, tunnel sessions expire, stopping or replacing a tunnel revokes old artifacts, and password/passkey login is disabled on the public tunnel scope. None of those controls protect a managed provider tunnel until the missing orchestration calls the auth controller.

Managed remote tunnel tokens also need a secret-boundary review before this becomes a beta feature. The shared UI settings store returns the persisted settings object as JSON, and the UI settings type/sanitizer includes `managedRemoteTunnelToken` and `managedRemoteTunnelPresetTokens`. Those values are written through `/api/pi/ui-settings`. Unlike Pi provider credentials, they are currently part of a browser-visible settings contract for an authenticated client. Tunnel tokens should be write-only or server-owned before external exposure is advertised.

## Test and documentation coverage

The current tests cover useful pieces but not the product path:

- `packages/web/server/lib/ngrok-tunnel.test.js` tests ngrok URL extraction and error summarization.
- `packages/web/server/lib/tunnels/executable-search.test.js` tests cross-platform executable discovery.
- `packages/web/server/lib/tunnels/install-help.test.js` tests install guidance.
- `packages/web/bin/cli.test.js` tests fallback provider listing, dry-run parsing, and mocked CLI HTTP behavior.
- There is no current Cloudflare provider test, tunnel-route test, real provider lifecycle test, or external-tunnel SSE smoke test.

The public docs cover connecting devices and security but do not provide an external-tunnel guide. The migration records correctly describe tunnel support as deferred port work, while the current Settings/CLI surfaces still present tunnel controls without explaining that they are not wired in.

## What should count as beta support

A defensible beta label would separate these claims:

1. **Manual external endpoint:** supported as an advanced, user-managed HTTPS pairing candidate, provided the proxy forwards authenticated HTTP and unbuffered `/api/pi/events`.
2. **ngrok Quick:** provider implementation exists, but product support is not complete until the server route/orchestration is restored and an SSE smoke test passes.
3. **Cloudflare Managed Remote/Local:** intended persistent modes and the best Cloudflare fit, but currently only provider helpers and UI/CLI scaffolding exist.
4. **Cloudflare Quick:** do not present as a working live PiChamber tunnel. Its documented SSE limitation conflicts directly with the Pi event contract.
5. **Private relay:** track separately. It is not an external provider tunnel, and its host runtime is also currently documented as unwired.

The minimum work to make the first three claims true is to restore one server-owned tunnel service and route module, connect provider child-process lifecycle to status/stop/replacement, call the tunnel-auth controller when a provider becomes ready, remove or redact token reads from shared UI settings, update the Pi-native reverse-proxy/public docs, and add route/auth/provider/realtime integration tests.

## Sources

Repository sources:

- `packages/web/server/index.js`
- `packages/web/server/lib/tunnels/DOCUMENTATION.md`
- `packages/web/server/lib/cloudflare-tunnel.js`
- `packages/web/server/lib/ngrok-tunnel.js`
- `packages/web/server/lib/tunnels/providers/cloudflare.js`
- `packages/web/server/lib/tunnels/providers/ngrok.js`
- `packages/web/server/lib/server/tunnel-auth.js`
- `packages/web/server/lib/pi/routes.js`
- `packages/ui/src/lib/pi/transport.ts`
- `packages/ui/src/components/sections/pichamber/TunnelSettings.tsx`
- `packages/web/bin/lib/commands-tunnel.js`
- `packages/web/bin/lib/commands-connect-url.js`
- `packages/ui/src/lib/connectionPayload.ts`
- `docs/REVERSE_PROXY.md`
- `docs/pichamber-pi-workstream-0.md`
- `docs/pichamber-pimigration.md`

First-party provider sources, retrieved 2026-08-21:

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare remotely managed tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Cloudflare tunnel configuration file](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)
- [ngrok HTTP/S endpoints](https://ngrok.com/docs/http/)
- [ngrok SSE traffic-policy action](https://ngrok.com/docs/gateway/traffic-policy/actions/sse-find-replace)
- [ngrok Agent configuration](https://ngrok.com/docs/gateway/agent/config)

No provider binary was launched and no end-to-end tunnel connection was tested. The conclusions about current PiChamber wiring come from the checked-in composition root, callers, module documentation, and route inventory.
