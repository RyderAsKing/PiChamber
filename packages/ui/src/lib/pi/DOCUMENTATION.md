# Pi shared UI module

## Purpose

This directory owns the Pi-native runtime boundary. It defines:

- The Pi session / message / part data shapes (`types.ts`).
- The public `/api/pi/` IPC envelope (`protocol.ts`).
- The browser-side transport for `/api/pi/events` (`transport.ts`), using authenticated SSE by default and one active connection per stream generation. Explicit WebSocket mode remains only for runtimes that provide a matching upgrade endpoint; SSE comment heartbeats count as liveness.
- The service facade that wraps every `/api/pi/*` call (`client.ts`).
- The snapshot reducer helpers (`snapshot.ts`).
- The event reducer helpers (`event-reducer.ts`).
- The bootstrap owner (`bootstrap.ts`).
- The reconnect owner (`reconnect.ts`).
- The attachment helpers (`attachments.ts`).
- The model / provider helpers (`model-provider.ts`).

The module uses native `Response` parsing through `runtimeFetch` so callers
can distinguish failure from a successful empty result. `MainLayout` is the
mounted owner for web, desktop, mini-chat, and mobile chrome. Session truth
lives in `PiSessionStore` via `PiSessionProvider`; chat leaves consume
`pi-to-renderable` adapters rather than OpenCode SDK types.

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
`sequence` number scoped to a session id. Pi's delta `contentIndex` is a stable content-block identity and may repeat for every chunk in that block; reducers append those chunks and use event sequence for deduplication. The reducer rejects any event
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

## Mounted UI ownership

`packages/ui/src/apps/pi-session-store.ts` owns one active user-selected project,
including explicit daemon project selection, bootstrap, sequenced event reduction,
reconnect hydration, and runtime-switch disposal. It allocates a new hydration generation for every ready-state session selection, so stale rapid-click completions cannot replace the latest transcript. Cross-directory selection opens the target project and preferred session as one operation.

The global session store separately retains authoritative per-directory snapshots for every added project; switching the active Pi runtime directory must not erase unrelated project sessions. The mounted provider follows the
persisted PiChamber project store; with no project selected it clears session state
instead of adopting the daemon process cwd or the filesystem home as a visible project. `App.tsx`, `MobileApp.tsx`, and `ElectronMiniChatApp.tsx`
mount `PiSessionProvider` around `MainLayout` / the mobile shell / mini-chat.
The restored web shell bootstraps provider/model config through
`initializeApp()` in `SyncAppEffects`; `legacy-ui-client.getProvidersForConfig`
must return `{ providers, default }` so the config store can leave the picker
off the loading state. The picker only includes authenticated providers;
unconfigured catalog entries stay on the Providers settings page. Composer
chrome does not expose an OpenCode agent selector.
Chat, sidebar, and composer mutations go through `PiSessionStore` and `/api/pi/*`. Pi assistant projections preserve their owning user-message id end to end because the restored chat renderer groups assistant output into user turns by that identity. Tool parts preserve input, cumulative partial output, final output, error text, metadata, and start/end timestamps through the reducer and `pi-to-renderable`, satisfying the restored renderer's finalized-tool contract (a completed tool needs an end time and keeps its status verbatim, including `cancelled`).
Settings chrome is the restored OpenChamber hub limited to Pi-owned pages
(Providers, Skills, Snippets, Behavior/`AGENTS.md`, Magic Prompts, appearance
and other PiChamber pages). `PiResourceSettings.tsx` remains the page bodies
for those resource surfaces. A failed daemon probe must show an error banner,
never an empty idle session list.

Native resource discovery is projected from Pi's resource loader without filesystem paths. Skills are browse-only; Pi prompt templates and applicable global/project instruction files are edited only through opaque daemon identifiers. Project-local resources remain hidden until the browser makes an explicit persisted Pi trust decision; extensions remain disabled by the daemon.

Provider discovery is projected from Pi's model runtime without credentials.
The mounted Providers surface submits API keys once through the authenticated
adapter or renders Pi's opaque browser/device/manual-code login state; stored
credentials never return to the browser. Custom OpenAI-compatible providers
are written through the same adapter to Pi `models.json`; configuration
responses omit credentials and headers, which are write-only. PiChamber
new-session model/thinking plus small-model and walkthrough-model defaults
live in its own sidecar. Only the explicit new-session overrides are passed to
the daemon, so Pi's normal settings fallback remains authoritative otherwise.
Composer attachments are uploaded before prompt dispatch and the returned opaque identifiers are forwarded with that captured send. Attachment uploads return opaque identifiers; their temporary paths cross only
the private daemon IPC and are redacted from public transcript/event output.
The browser never receives a path, endpoint, credential, or daemon identity.
