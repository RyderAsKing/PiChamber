# Pi shared UI module

## Purpose

This directory replaces the legacy `packages/ui/src/lib/opencode/` facade for
the Pi-native runtime. It defines:

- The Pi session / message / part data shapes (`types.ts`).
- The public `/api/pi/` IPC envelope (`protocol.ts`).
- The browser-side transport for `/api/pi/events` (`transport.ts`), using the
  shared authenticated runtime HTTP/SSE/WS helpers and one active connection
  per stream generation.
- The service facade that wraps every `/api/pi/*` call (`client.ts`).
- The snapshot reducer helpers (`snapshot.ts`).
- The event reducer helpers (`event-reducer.ts`).
- The bootstrap owner (`bootstrap.ts`).
- The reconnect owner (`reconnect.ts`).
- The PiChamber-owned archive sidecar (`archive.ts`).
- The attachment helpers (`attachments.ts`).
- The model / provider helpers (`model-provider.ts`).

The module intentionally does not depend on any OpenCode SDK type or route
name. Where the legacy service exposed `OpencodeService`, this module exposes
`PiService` plus thin wrappers (`piClient`, `createScopedPiClient`). Where
the legacy `client.ts` returned `{ data, error, response }` HeyApi envelopes,
the new facade uses native `Response` parsing through `runtimeFetch` so the
caller can distinguish failure from successful empty data without an SDK
import.

## Public types vs. private runtime

The browser-facing shapes are the public contract. The daemon module owns
the private IPC; the server-side proxy translates one to the other. UI code
must never import the private daemon shapes.

## Failure semantics

Every fetch helper that can mutate, replace, or clear state throws on
failure. The bootstrap and reconnect owners record failures into a list of
phase-tagged errors rather than swallowing them; the caller decides whether
to retry or surface a toast.

A failed runtime probe is `unavailable`, not an empty session list. The
sidebar must show the unavailable banner until the daemon reports `ready`
again; the bootstrap owner returns `phase: 'failed'` only when the probe
fails, and `phase: 'unavailable'` would have been a misnomer — the probe
path returns `phase: 'failed'` with an explicit `errors[]` entry so the
caller can render the correct message.

## Sequencing and reconnect

Every event the public stream publishes carries a monotonically increasing
`sequence` number scoped to a session id. The reducer rejects any event
whose sequence is `<=` the last accepted sequence, so a reconnect that
resumes from `snapshot.lastSequence` cannot double-apply events. A snapshot
is itself an event with `name: 'session.snapshot'`; the snapshot reducer
replaces the running state when the snapshot's `lastSequence` is strictly
greater than the previously accepted snapshot.

## Runtime-switch and failure handling

Service requests capture an optional runtime key and re-check it after the
response has arrived, so a remote-host switch cannot commit an old response
into the new runtime. Stream generations use the same captured identity; old-
runtime events and reconnect completions are ignored. The event stream uses
the shared authenticated URL resolver for WebSocket and SSE URLs, `runtimeFetch`
for SSE, and `openRuntimeWebSocket` for WS/relay operation. Only one connection
is active per generation; a failed WS is closed before SSE fallback or
reconnect begins.

## Deliberate limits

This module is the typed boundary, not a finished UI. The owning store in
`packages/ui/src/sync/` wraps the reducer with a Zustand store and the
sync-context layer wires it to the directory bootstrap scheduler. Workstream
3 lays the foundation; the UI cutover is a follow-up workstream that
replaces the legacy consumers.
