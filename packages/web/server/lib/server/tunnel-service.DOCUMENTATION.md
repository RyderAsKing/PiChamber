# Cloudflare Tunnel Service

PiChamber exposes a PiChamber-hosted Cloudflare Tunnel that lets a browser or mobile client reach a private PiChamber server without opening inbound ports. The server dials outbound to Cloudflare with `cloudflared`; the public hostname then proxies to the local PiChamber HTTP endpoint.

## Modes

- **Quick** (`quick`): ephemeral `*.trycloudflare.com` URL, no account required, best-effort. Uses `cloudflared tunnel --url http://127.0.0.1:<port>`. Good for demos, not for production (no SLA, no SSE guarantees).
- **Managed Remote** (`managed-remote`): persistent hostname backed by a Cloudflare Tunnel token. Requires `token` (from `cloudflared tunnel create` / dashboard) and `hostname` (e.g. `pichamber.example.com`). Uses `cloudflared tunnel run --token-file ...` and stores the token on disk with `0600`.
- **Managed Local** (`managed-local`): uses a local `config.yml` (`~/.cloudflared/config.yml` by default) whose `ingress` hostname is proxied. Uses `cloudflared tunnel --config <path> run`.

Quick is the default when no hostname/token is supplied.

## Server component

`createTunnelService({ dataDir, getPort, tunnelAuthController })` owns the tunnel child process and its public URL. It checks `cloudflared` availability via `checkCloudflaredAvailable` (plus `getTunnelDependencyInstallInfo` for the install command), validates mode inputs before touching the binary, and redacts tokens in every response.

- `GET /api/pichamber/tunnel/check` – availability + install help
- `GET /api/pichamber/tunnel/status` – active, url, mode, bootstrap token presence, managed-remote token presence (boolean only), hostname, sessions, localPort
- `POST /api/pichamber/tunnel/start` – body `{ mode, token, hostname, configPath }`
- `POST /api/pichamber/tunnel/stop` – stops the child and clears `tunnelAuthController`
- `PUT /api/pichamber/tunnel/managed-remote-token` – stores token/hostname for later starts
- `GET /api/pichamber/tunnel/doctor` – status + check for diagnostics

All routes are behind `uiAuthController.requireAuth`, so a bearer client or UI session is required; anonymous callers get `401`.

The service sets `tunnelAuthController.setActiveTunnel` and issues a one-time bootstrap token (`/connect?t=...`) when the tunnel becomes active. Stopping clears it. The bootstrap token is `HttpOnly`, short-lived (30 min), and revoked when the tunnel is replaced or stopped.

Remote traffic is still authenticated by `tunnelAuthController` and `uiAuthController`; the tunnel only provides reachability, not authorization. `isSecureRequest` (X-Forwarded-Proto) and `isRequestOriginAllowed` continue to enforce origin and WebSocket upgrade checks even when traffic arrives via the tunnel.

## Secret handling

- Tokens are written to `<dataDir>/cloudflare-tunnel-token.json` with `0600`; the hostname is stored alongside so `status` can report it without exposing the token.
- `status` never returns the raw token, only `hasManagedRemoteTunnelToken: boolean` and the hostname.
- Logs and error messages use `redactToken` (`abcd***wxyz`).
- `cloudflared` stdout/stderr is drained but not logged with token material.

## Systemd on Linux remote servers

The tunnel child is normally supervised by the PiChamber server process (it dies when the server stops, and `stop` kills `SIGINT`). On a Linux remote server the same `cloudflared` can be run as a managed systemd service if the operator prefers:

```
# /etc/systemd/system/pichamber-cloudflared.service
[Unit]
Description=PiChamber Cloudflare Tunnel
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel run --token-file /var/lib/pichamber/cloudflare-tunnel-token
Restart=always

[Install]
WantedBy=multi-user.target
```

The PiChamber `pichamber.service` itself already supports both user (`~/.config/systemd/user/pichamber.service`, `systemctl --user`) and system (`/etc/systemd/system/pichamber.service`, `systemctl`) scopes; the tunnel service follows the same scope so a root VPS gets a system unit that works immediately after install without `loginctl enable-linger`.

## Upgrade considerations

`pichamber update` detects the owning package manager, upgrades the global package, and restarts the relevant systemd service (`systemctl --user restart pichamber.service` or `systemctl restart pichamber.service` when running as root). The tunnel token file and PiChamber `pi/settings.json` sidecar are preserved across upgrades because they live under `PICHAMBER_DATA_DIR` (or `~/.pichamber`), not in the package directory. A Docker deployment is not upgraded in-place; it must be redeployed via `docker pull`.

## Testing

- `tunnel-service.test.js` covers validation (missing token/hostname, unsupported mode), status shape, secret redaction, and that `missing_dependency` is reported when `cloudflared` is absent.
- Integration smoke against a real `cloudflared` binary is manual: install `cloudflared`, run `pichamber serve`, `curl /api/pichamber/tunnel/check`, start a quick tunnel, verify `status.url` appears and `curl -H "Host: $url-host"` reaches the server through the tunnel with `Authorization` still required.

## Cloudflare permissions for API-token flow

If the operator wants PiChamber to create a tunnel automatically (rather than pasting a token), the Cloudflare API token needs:

- `Zone:Read`, `DNS:Edit` on the zone that will host the hostname
- `Account:Cloudflare Tunnel:Edit` (to create/list tunnels)

PiChamber never asks for the Cloudflare account password. The manual token flow is the default; the API-token flow is an optional convenience that calls `https://api.cloudflare.com/client/v4/accounts/{accountId}/cfd_tunnel` with the scoped token. Secrets are still stored with `0600` and never returned in API responses.
