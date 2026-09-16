# Notifications

## Ownership

This module owns server-side notification delivery for Pi session completion and terminal errors.
It does not model OpenCode questions, permissions, subagents, or tool completion.

`pi-notification-watcher.js` maintains one server-owned subscription to the Pi session daemon. A live `busy` or `retry` lifecycle, or an assistant start, opens a turn. The first terminal `idle` emits a completion notification and the first `session.error` or terminal `error` emits an error notification. Duplicate terminal boundaries do nothing. Bootstrap snapshots seed activity but never notify for old settled work. User interruption settles without notifying.

The watcher reads `/api/pi/ui-settings` storage before delivery. Notifications require `nativeNotificationsEnabled`; `notifyOnCompletion` and `notifyOnError` gate their respective events.

`delivery-runtime.js` fans one generic payload out to:

- Electron's native callback when the web server runs inside the desktop app.
- Browser Web Push subscriptions.
- Capacitor device tokens through the PiChamber push relay.

Payloads contain a fixed completion/error title, the session title when known, an opaque session ID for navigation, and a stable event tag. They never contain prompts, assistant output, tool input/output, provider credentials, or error details.

## Routes

`routes.js` registers authenticated endpoints:

- `GET /api/push/vapid-public-key`
- `POST` and `DELETE /api/push/subscribe`
- `POST` and `DELETE /api/push/apns-token`
- `POST /api/push/visibility`

The persisted `notifications.json` file contains VAPID private material, relay signing keys, browser subscriptions, and native device tokens. It is written atomically with owner-only permissions under the PiChamber data directory. Never log its contents.

## Mobile relay

Native iOS and Android registration uses `@capacitor/push-notifications`. The server binds each token to its per-server signing key and sends signed requests to `https://api.pichamber.dev/v1/push/send` by default. Override with `PICHAMBER_PUSH_RELAY_URL`; set `PICHAMBER_PUSH_RELAY_DISABLED=true` to disable native relay delivery.

The app suppresses foreground native banners. A recent visible desktop or browser client suppresses native mobile fanout, avoiding a second device alert while the user is already watching the session.

## Failure behavior

One failed delivery channel does not block the others. Dead Web Push endpoints are removed after HTTP 404/410. Registration failure is visible to the client. The watcher reconnects to the daemon with its sequence and stream epoch, so replayed terminal events remain deduplicated by the active-turn state.
