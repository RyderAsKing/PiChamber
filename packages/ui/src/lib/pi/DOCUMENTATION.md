# Pi shared UI module

## Purpose

This directory owns the Pi-native runtime boundary. It defines:

- The Pi session / message / part data shapes (`types.ts`).
- The public `/api/pi/` IPC envelope (`protocol.ts`).
- The browser-side transport for `/api/pi/events` (`transport.ts`), using authenticated SSE by default and one active connection per stream generation. Explicit WebSocket mode remains only for runtimes that provide a matching upgrade endpoint; SSE comment heartbeats count as liveness.
- Stream cadence (`stream-cadence.ts`): adjacent same-part token deltas fold, then flush on `requestAnimationFrame`; boundary events flush pending deltas first.
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
`sequence` number from the daemon's global counter. The reducer stores the last
accepted sequence per session id and rejects any event for that session whose
sequence is `<=` the last accepted value. `getSession` reports that same global
cursor, not proof that the returned transcript contains every locally applied
delta, so hydration overlays an in-flight busy/retry turn onto the fetched
history instead of replacing it. Reconnect resumes from
`max(clientAppliedMax, snapshot.lastSequence)` so a quieter session cannot
rewind the directory stream into the retained event log. It fetches the
selected session snapshot but reattaches a directory-wide stream; narrowing
that stream would lose events after the next resident session switch. Pi's delta
`contentIndex` is a stable content-block identity and may repeat for every
chunk in that block; reducers append those chunks and use event sequence for
deduplication. A snapshot is itself an event with `name: 'session.snapshot'`;
The snapshot reducer replaces the running state when the snapshot's
`lastSequence` is strictly greater than the previously accepted snapshot.
Reconnect still unions an in-flight session's existing messages onto that
snapshot so a mid-send reconnect cannot blank the open transcript.

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
reconnect hydration, and runtime-switch disposal. Directory generation advances on
project open, clear, and runtime switch — not on session selection. Selecting a
session that is already hydrated is a pointer change on the live directory
stream; an unhydrated session fetches its transcript without tearing the stream
down. The chat surface waits on `hydratedSessionIds` before painting a session,
so a cached or event-partial transcript cannot flash thinking-block animations
while `getSession` is still merging. Selecting the already-open session retries
hydrate when that id is missing from `hydratedSessionIds`. Live event stubs are not treated as complete transcripts. Hydration writes into `bySession` by session id, so an in-flight fetch for
session A cannot replace session B's transcript. An in-flight `getSession` that
finishes after the user has already started a turn keeps every live message and
part (existing ids win on overlap) and only fills in history the live reducer
does not yet have. A stale or empty-bodied fetch must not blank a transcript
the user is already looking at. Stream user events use synthetic ids
(`user-<sessionId>-<sequence>`); hydration aliases those onto the persisted
JSONL user with the same text and matching event timestamp so a single send
cannot render twice while a genuinely repeated prompt remains a separate turn.
An empty intermediate assistant error is omitted from projection only when a
later assistant record under the same user turn proves the run recovered;
unrecovered terminal errors remain visible. `session.error` ends the live
assistant: streaming flags clear, duration is filled, and running tools go to
`error` so the status row cannot keep "Analyzing" after the provider stream
dies. A follow-up send after that error is a new turn; skipped stale error
events and idle reconnect snapshots must not settle a prompt that has already
been accepted. Stream token deltas are folded
and flushed once per animation frame; start/end/lifecycle events flush immediately
and keep sequence order. The directory stream attaches with the hydrated lastSequence
cursor so the client does not replay the retained event log from zero. Cross-directory selection opens the target project and preferred session as one operation.

The global session store separately retains authoritative per-directory snapshots for every added project; switching the active Pi runtime directory must not erase unrelated project sessions. The mounted provider follows the
persisted PiChamber project store; with no project selected it clears session state
instead of adopting the daemon process cwd or the filesystem home as a visible project. `App.tsx`, `MobileApp.tsx`, and `ElectronMiniChatApp.tsx`
mount `PiSessionProvider` around `MainLayout` / the mobile shell / mini-chat.

`usePiSessionSnapshot` caches by store snapshot identity and does not re-run a
selector that closed over a different session or message id while that snapshot
is unchanged. Chat hooks subscribe to `reducer.bySession` / `hydratedSessionIds`
and look the id up after the snapshot read, so opening session B cannot keep
rendering session A's transcript.
React consumers read `PiSessionStore` through `usePiSessionSnapshot(selector)`.
The selector must return a leaf or a stable per-session record; omitting it
re-renders every subscriber on each accepted event.
The restored web shell bootstraps provider/model config through
`initializeApp()` in `SyncAppEffects`; `legacy-ui-client.getProvidersForConfig`
must return `{ providers, default }` so the config store can leave the picker
off the loading state. The picker only includes authenticated providers;
unconfigured catalog entries stay on the Providers settings page. Composer
chrome does not expose an OpenCode agent selector.
Chat, sidebar, and composer mutations go through `PiSessionStore` and `/api/pi/*`. Pi assistant projections preserve their owning user-message id end to end because the restored chat renderer groups assistant output into user turns by that identity. Tool parts preserve input, cumulative partial output, final output, error text, metadata, and start/end timestamps through the reducer and `pi-to-renderable`, satisfying the restored renderer's finalized-tool contract (a completed tool needs an end time and keeps its status verbatim, including `cancelled`).
Settings chrome is the restored OpenChamber hub limited to Pi-owned pages
(Providers, Skills, Snippets, Behavior/`AGENTS.md`, Magic Prompts, appearance
and other PiChamber pages). A failed daemon probe must show an error banner,
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
