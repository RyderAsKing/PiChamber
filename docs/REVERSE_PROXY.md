# Reverse proxy setup

Use this guide when running PiChamber behind Nginx, Nginx Proxy Manager,
Caddy, Cloudflare, or another HTTPS reverse proxy.

## Before you proxy it

1. Start PiChamber directly and confirm that the browser UI works.
2. Bind the server to a private interface and set a UI password before making
   it reachable from another machine.
3. Add the reverse proxy only after the direct connection works.

A reverse proxy provides reachability. It does not replace PiChamber
authentication.

## Routes that need special handling

- `GET /api/pi/events` is the authenticated Server-Sent Events stream. Disable
  buffering and compression for this route.
- `/api/terminal/ws` is the authenticated terminal WebSocket.
- `/api/stt/ws` is the authenticated dictation WebSocket.
- `/api/pi/*`, `/api/git/*`, `/api/fs/*`, and other API paths need normal
  authenticated proxying and a request body limit large enough for attachments.
- Long-lived API and WebSocket requests need a read timeout of at least one hour.

Do not rewrite API paths or remove query parameters. Browser clients may use a
short-lived `oc_url_token` when a transport cannot send an authorization header.

## General rules

- Use HTTP/1.1 for WebSocket locations.
- Forward `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`.
- Disable buffering for the Pi event stream.
- Disable compression for the event stream. Compress ordinary responses in one
  layer only.
- Allow request bodies large enough for the attachment limits you intend to
  support.
- Keep the proxy and PiChamber on a private network when possible.

## Nginx

```nginx
client_max_body_size 50M;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;

location = /api/pi/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Connection "";
    proxy_set_header Accept "text/event-stream";
    proxy_set_header Cache-Control "no-cache";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    add_header X-Accel-Buffering "no" always;
    add_header Cache-Control "no-cache, no-transform" always;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location = /api/terminal/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location = /api/stt/ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location /api {
    proxy_pass http://127.0.0.1:3000;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location / {
    proxy_pass http://127.0.0.1:3000;
}
```

For Nginx Proxy Manager, enable **Websockets Support** for the host and add the
three route-specific locations in the Advanced configuration. Keep the same
body limit, forwarded headers, buffering, and timeout values.

## Caddy

Caddy handles WebSocket upgrades automatically. Disable buffering for the
long-lived stream with `flush_interval -1`:

```caddy
reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}

    transport http {
        read_timeout 3600s
        write_timeout 3600s
    }
}
```

Set a suitable `request_body` limit in the Caddy configuration if your users
need larger attachments.

## Cloudflare

A normal Cloudflare Tunnel can carry the authenticated HTTP, SSE, and
WebSocket routes above. Quick Tunnels are for testing and have no reliable SSE
service guarantee. Use a managed tunnel or another proxy for a persistent
server.

## Check the result

- Open the UI through the public hostname.
- Start a session and confirm that tokens and tool output continue to arrive.
- Open the terminal and confirm that input and output work.
- Test dictation only when microphone access is configured.
- Watch the browser network panel for an open `/api/pi/events` request. It must
  not buffer all events until the request closes.

If the page loads but live output does not update, check SSE buffering first.
If terminal or dictation fails, check WebSocket upgrade handling and make sure
the proxy preserves the `oc_url_token` query parameter.
