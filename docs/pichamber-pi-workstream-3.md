# PiChamber Pi Migration: Workstream 3 Implementation Record

## Status and scope

This record covers the Pi-native session UI delivered for Workstream 3 of the
approved [Pi migration plan](./pichamber-pimigration.md). The mounted web,
desktop, and mobile session surface uses `PiService` and the sequenced Pi
session store; it does not mount `OpencodeService` or the legacy SDK sync
provider for session behavior.

There is no dual-runtime session path. The authenticated `/api/pi/*`
contract is the sole mounted session backend.

## Implemented ownership

| Surface | Implementation | Rationale |
| --- | --- | --- |
| Pi types | `packages/ui/src/lib/pi/types.ts` | Replaces `@opencode-ai/sdk/v2` data shapes for session/message/part/provider/resource. Deliberately does not preserve OpenCode endpoint, event, or type-alias names. |
| Public protocol envelope | `packages/ui/src/lib/pi/protocol.ts` | Versioned `/api/pi/` request/response/event shapes. Every session event has a monotonic `sequence` and `sessionId`. |
| Browser event transport | `packages/ui/src/lib/pi/transport.ts` | Reuses `runtimeFetch`, `openRuntimeWebSocket`, and the runtime URL resolver so the relay/tunnel transports keep working. Falls back from WebSocket to SSE on read failure. |
| Service facade | `packages/ui/src/lib/pi/client.ts` | `PiService` plus `piClient` and `createScopedPiClient(directory)`. Throws `PiRequestError` on fetch failures; never fabricates a successful empty value. |
| Snapshot reducer | `packages/ui/src/lib/pi/snapshot.ts` | Pure `applySnapshot` / `projectSnapshot` helpers. The `lastSequence` watermark is the reconnect baseline. |
| Event reducer | `packages/ui/src/lib/pi/event-reducer.ts` | Pure sequenced event reducer. Assembles text/thinking deltas into finalized messages; flips the lifecycle phase on `session.interrupted`; flips streaming messages to error without marking them completed. |
| Bootstrap owner | `packages/ui/src/lib/pi/bootstrap.ts` | Per-directory cold start: runtime probe → session list → optional session hydrate → stream attach. Phases are tagged so the UI can render the correct state. |
| Reconnect owner | `packages/ui/src/lib/pi/reconnect.ts` | Health probe → snapshot fetch → stream attach with the snapshot's sequence as the resume watermark. Preserves the hydrated transcript and does not invent a daemon sequence for transport disconnects. |
| Archive sidecar | `packages/ui/src/lib/pi/archive.ts` | PiChamber-only metadata; the browser never edits Pi JSONL. |
| Attachment helpers | `packages/ui/src/lib/pi/attachments.ts` | Filename sanitization, MIME normalization, base64 helpers, server-local path metadata. |
| Model/provider helpers | `packages/ui/src/lib/pi/model-provider.ts` | Picker-friendly sorting, comparison helpers, and the agreed new-session precedence (explicit → configured → Pi fallback). |
| Mounted UI owner | `packages/ui/src/apps/pi-session-store.ts`, `PiApp.tsx` | One active-project owner handles bootstrap, sequenced events, reconnect, runtime switches, session actions, provider model discovery, and opaque attachment upload. |
| Documentation | `packages/ui/src/lib/pi/DOCUMENTATION.md` | Owner boundaries, public types vs. private runtime, failure semantics, sequencing rules, and the deliberate limits of the foundation. |

## Mounted flow coverage

The Pi application covers project/session bootstrap, authoritative session
list and transcript hydration, live user/assistant/reasoning/tool rendering,
prompt/steer/follow-up/abort, provider-backed model selection and thinking,
rename/tree/fork/clone/compact/archive/delete, snapshot reconnect, runtime
switch rejection, and explicit unavailable/error/interrupted rendering.

Attachments are uploaded as bounded opaque objects. Browser-visible payloads
never contain their temporary filesystem paths; the server resolves the path
only while forwarding the private prompt request and the daemon redacts it
from public transcript and event projections.

## New-session defaults

The model/provider helpers implement the agreed precedence from the
migration plan: an explicit UI selection beats a configured PiChamber
default, which beats the Pi settings fallback. After the user picks a
model or thinking inside an existing session, the in-session choice wins
and the global default does not reset it.

## Sequencing and reconnect

Every event published by `/api/pi/events` carries a `sequence` number
scoped to the session id. The event reducer rejects any event whose
`sequence` is `<=` the last accepted sequence. A reconnect receives a
`session.snapshot` event whose `lastSequence` is the watermark; the
reducer advances from there.

Authoritative `session.interrupted` events flip the lifecycle phase to `interrupted`
and finalize any streaming assistant messages as `error` with
`code: SESSION_INTERRUPTED`. A forced daemon restart does not display a
successful completion.

## Failure semantics

A failed runtime probe returns `phase: 'failed'` with an explicit
`errors[]` entry; the UI never receives an empty session list as
fabricated idle state. The session-list and session-hydrate steps can
fail without flipping the overall bootstrap phase, because the stream
attach can still succeed — but every failure is captured for diagnostics.

## Deliberate limits

- Provider credential mutation, provider configuration, resource settings,
  and advanced document extraction retain their owning dedicated workstreams.
- The Pi SDK is not imported anywhere under `packages/ui/`; only the web
  server owns it. The UI talks to the public `/api/pi/` namespace, and
  the server proxies to private daemon IPC.

## Validation evidence

Focused tests use `bun test` and live next to the modules they exercise:

- `packages/ui/src/lib/pi/protocol.test.ts` — `isPiEvent`, `PI_PUBLIC_PROTOCOL_VERSION`, the canonical event names.
- `packages/ui/src/lib/pi/types.test.ts` — (omitted; types are pure type-level assertions).
- `packages/ui/src/lib/pi/snapshot.test.ts` — snapshot monotonicity, multi-session tracking, projection shape.
- `packages/ui/src/lib/pi/event-reducer.test.ts` — sequencing, text/thinking assembly, tool lifecycle, interrupted/error lifecycle, snapshot hydration.
- `packages/ui/src/lib/pi/client.test.ts` — service facade, `PiRequestError` surface, health fetch on 401/protocol mismatch.
- `packages/ui/src/lib/pi/bootstrap.test.ts` — runtime probe success/failure, session-list failure does not abort bootstrap, stream attach.
- `packages/ui/src/lib/pi/reconnect.test.ts` — unavailable, snapshot resume, and 404 session handling.
- `packages/ui/src/lib/pi/attachments.test.ts` — filename sanitization, MIME normalization, base64 helpers, validation.
- `packages/ui/src/lib/pi/model-provider.test.ts` — picker sorting, model lookup, thinking allowance, new-session precedence.

`bun test packages/ui/src/lib/pi/` reports **79 passing tests** with **0
failures** as of this workstream.

`bun run type-check:ui` is clean. `bun run lint:ui` is clean.

`bun run dead-code` flags the new files as unused because no consumer has
adopted them yet. The report is non-blocking and the foundation is
intended to be adopted by the follow-up UI cutover workstreams.

The workstream does not run a live Pi session because the
`/api/pi/projects`, `/api/pi/sessions`, and `/api/pi/events` server routes
are added by a separate, still-in-progress workstream; the foundation here
is independent of those routes and tests against the documented contract.
