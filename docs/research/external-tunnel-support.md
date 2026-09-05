# External tunnel support research

## Current conclusion

PiChamber has a server-owned Cloudflare Tunnel service. The web server creates
the service in `packages/web/server/index.js`, exposes authenticated tunnel
routes, supervises the `cloudflared` child, and connects the active tunnel to
the tunnel authentication controller.

Cloudflare is the supported provider in the current Pi-native runtime. The
standalone CLI command is the supported entrypoint:

```sh
pichamber tunnel ready
pichamber tunnel start --mode quick
pichamber tunnel status
pichamber tunnel stop
```

`pichamber serve` does not start a tunnel. Passing old top-level tunnel options
to `serve` produces a warning and does not expose the server.

## Modes

| Mode | Behavior | Release guidance |
| --- | --- | --- |
| `quick` | Starts `cloudflared tunnel --url` and returns an ephemeral `trycloudflare.com` URL. | Good for a short demo. Cloudflare documents no SLA and no reliable SSE guarantee for Quick Tunnels. |
| `managed-remote` | Runs a persistent Cloudflare tunnel with a token and hostname. | Preferred for a persistent remote server. |
| `managed-local` | Runs an existing `cloudflared` config file, using its ingress hostname. | Useful when the operator already manages the tunnel config. |

PiChamber stores managed-remote token material under the data directory with
mode `0600`. Status responses expose token presence and hostname, not the raw
token. The UI and CLI manual-token flows are supported. PiChamber does not
create a Cloudflare tunnel through a Cloudflare API-token wizard, so public docs
must not promise that flow.

## Server contract

`createTunnelService` owns the child process and exposes these authenticated
routes:

- `GET /api/pichamber/tunnel/check`
- `GET /api/pichamber/tunnel/status`
- `GET /api/pichamber/tunnel/providers`
- `POST /api/pichamber/tunnel/start`
- `POST /api/pichamber/tunnel/stop`
- `PUT /api/pichamber/tunnel/managed-remote-token`
- `GET /api/pichamber/tunnel/doctor`

The service starts one tunnel at a time. Starting a new mode stops the active
child first. When a public URL becomes available, the service registers it with
the tunnel auth controller and issues a short-lived one-time `/connect?t=...`
link. Stopping or replacing the tunnel clears the active tunnel and revokes old
bootstrap state.

The tunnel provides reachability, not authorization. UI sessions, client
credentials, origin checks, and URL-scoped transport tokens still protect the
server. The public event stream is `GET /api/pi/events` over SSE. Terminal and
dictation use `/api/terminal/ws` and `/api/stt/ws`.

## Reverse proxies and live traffic

A user-managed HTTPS reverse proxy is also a valid advanced setup when it
forwards authenticated HTTP, `/api/pi/events` without buffering, and the
terminal or dictation WebSockets. See `docs/REVERSE_PROXY.md` for the route
requirements.

Cloudflare Quick Tunnels should not be described as a production live-session
path. A managed Cloudflare Tunnel or a tested user-managed reverse proxy is the
safer release recommendation.

## What is not supported

- ngrok is not a current PiChamber tunnel provider.
- `pichamber serve --try-cf-tunnel` and other top-level serve tunnel flags are
  removed from the public contract.
- PiChamber does not accept a Cloudflare account password or promise automatic
  tunnel creation from a Cloudflare API token.
- A tunnel does not bypass the UI password, pairing, client authentication, or
  server filesystem permissions.

The private relay is a separate transport. Do not call it a Cloudflare Tunnel
or imply that enabling one enables the other.

## Evidence and tests

The implementation is covered by:

- `packages/web/server/lib/server/tunnel-service.test.js` for mode validation,
  status shape, token redaction, and missing `cloudflared` behavior
- CLI tests for provider discovery, dry runs, start, stop, and output modes
- UI tunnel state tests and the authenticated server route contract

A release that advertises remote access still needs a manual smoke test with a
real `cloudflared` binary. Verify the public URL, one-time connect link, login,
Pi event stream, terminal, stop/revoke behavior, and a restart. Do not put the
resulting URL, token, or session content in a committed artifact.
