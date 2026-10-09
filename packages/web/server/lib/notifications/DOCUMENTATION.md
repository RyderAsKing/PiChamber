# Notifications

## Ownership

This module owns local session completion/error notifications. It does not
model OpenCode questions, permissions, subagents, or tool completion, and it
sends nothing off the machine: there is no push delivery, no registered
routes, and no hosted relay.

`pi-notification-watcher.js` maintains one server-owned subscription to the Pi
session daemon. A live `busy` or `retry` lifecycle, or an assistant start,
opens a turn. The first terminal `idle` emits a completion notification and
the first `session.error` or terminal `error` emits an error notification.
Duplicate terminal boundaries do nothing. Bootstrap snapshots seed activity but
never notify for old settled work. User interruption settles without
notifying.

The watcher reads `/api/pi/ui-settings` storage before delivery.
Notifications require `nativeNotificationsEnabled`; `notifyOnCompletion` and
`notifyOnError` gate their respective events.

## Local delivery

The watcher takes a plain `notify(payload)` callback instead of a delivery
runtime. `startWebUiServer` only creates and starts the watcher when
`options.onDesktopNotification` is a function — in practice supplied by
Electron, which shows the OS notification (`maybeShowNativeNotification`).
Web and CLI servers pass no callback, so the watcher never runs there.

Payloads contain a fixed completion/error title, the session title when known,
an opaque session ID for navigation, a stable event tag, and the desktop
hints (`kind`, `sessionId`, `directory`, `requireHidden`) the callback
received before. They never contain prompts, assistant output, tool
input/output, provider credentials, or error details. Callback failures and
timeouts are caught and logged; they never break the watcher.

## Retired push surface

The push-only routes (`GET /api/push/vapid-public-key`, `POST`/`DELETE
/api/push/subscribe`, `POST`/`DELETE /api/push/apns-token`, `POST
/api/push/visibility`) and the push delivery runtime (VAPID keys, browser
subscriptions, native tokens, relay signing, `PICHAMBER_PUSH_RELAY_URL`,
`PICHAMBER_PUSH_RELAY_DISABLED`) were removed. Existing
`<dataDir>/notifications.json` files are simply no longer read; they are left
in place and no migration runs.

## Failure behavior

The watcher reconnects to the daemon with its sequence and stream epoch, so
replayed terminal events remain deduplicated by the active-turn state.
