# Pi shared UI module

## Purpose

This directory owns the Pi-native runtime boundary. It defines:

- The Pi session / message / part data shapes (`types.ts`).
- The public `/api/pi/` IPC envelope (`protocol.ts`).
- The browser-side transport for `/api/pi/events` (`transport.ts`), using authenticated SSE by default and one active connection per stream generation. Explicit WebSocket mode remains only for runtimes that provide a matching upgrade endpoint; fetch-based SSE comment heartbeats count as liveness.
- Stream cadence (`stream-cadence.ts`): adjacent same-part token deltas fold, then flush on `requestAnimationFrame` together with live `session.tool.update` frames; boundary events flush pending stream frames first.
- The service facade that wraps every `/api/pi/*` call (`client.ts`).
- The snapshot reducer helpers (`snapshot.ts`).
- The event reducer helpers (`event-reducer.ts`). `projectSession` is incremental: pass the previous session and projection so unchanged historical messages and parts keep their object identity, and a no-op live-tail remap returns the previous projection object. Ordered message lists are cached on the reducer `messages` Map; projected parts are cached on reducer part identity. `parts` is a copy-on-write map (`CowMap`): token/tool deltas `fork()` a snapshot-private overlay instead of cloning every historical part, and flatten after a bounded depth. Each applied event records `lastMutatedMessageId` / `lastMutationKind` so live-tail freeze can skip an O(session) part walk.
- The bootstrap owner (`bootstrap.ts`).
- The reconnect owner (`reconnect.ts`).
- The attachment helpers (`attachments.ts`).
- The configured-provider helper for selection catalogs (`configured-providers.ts`).
- Hidden-model selection filtering (`hidden-models.ts`).
- Session default helpers (`session-defaults.ts`) and Pi thinking-level rules (`thinking.ts`).
- Composer thinking apply/rollback (`apply-composer-thinking.ts`).

The module uses native `Response` parsing through `runtimeFetch` so callers
can distinguish failure from a successful empty result. `MainLayout` is the
mounted owner for web, desktop, mini-chat, and mobile chrome. Session truth
lives in `PiSessionStore` via `PiSessionProvider`; chat leaves consume
`pi-to-renderable` adapters rather than OpenCode SDK types.

Capacitor's native HTTP fetch adapter buffers long responses, so direct native
mobile clients use URL-authenticated `EventSource` for `/api/pi/events`.
Relay-backed mobile clients continue through `runtimeFetch` and the encrypted
tunnel, where browser `EventSource` cannot address the virtual endpoint.

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
history instead of replacing it. Sending a prompt on an already-open session
must not install an empty `bySession` row: live events only carry the new
turn, so a blank placeholder would make prior history disappear. If the
resident transcript is missing or empty, `prompt()` re-hydrates from the
append-only session log first. The same restore runs when a live event
arrives for a session whose transcript was dropped but whose `lastSequence`
cursor remains. That restore forces `getSession` even if the live event already
created a one-turn resident row, then overlays the JSONL log onto it. Reconnect resumes from
`max(clientAppliedMax, snapshot.lastSequence)` so a quieter session cannot
rewind the runtime stream into the retained event log. It merges the selected
session snapshot into the existing cluster without disposing other hydrated
sessions, and reattaches the runtime-wide stream; narrowing that stream would
lose events after the next resident session switch. Pi's delta
`contentIndex` is a stable content-block identity and may repeat for every
chunk in that block; reducers apply those chunks with `applyAssistantTextDelta`
(incremental suffix, cumulative snapshot, or bounded overlapping tail) and
use event sequence for deduplication. Cadence folding uses the same merge so
a frame of cumulative chunks cannot concatenate into stuttering markdown.
`assistant.message.end` writes the canonical `text`/`thinking` onto the
rendered parts; message-level fields alone are not what the chat paints.
Thinking parts also clear `streaming` as soon as a later text or tool part
on the same message starts, so the thinking block can collapse at handoff
instead of waiting for message-end.
When the producing turn carries Pi `Usage`, the same event also attaches the
sanitized `usage` to the assistant message record so the context sidebar can
read it directly. The `usage` shape is `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }` —
numbers only, finite, non-negative, never NaN or unknown keys. Pi has no
separate reasoning-token field; thinking is a content block, so the
sidebar's reasoning tile stays `—` when `usage` is present. The snapshot
hydrate path and `assistant.message.start` event do not carry usage; the
authoritative source is the message-end turn completion. A snapshot is itself an event with `name: 'session.snapshot'`;
The snapshot reducer replaces the running state when the snapshot's
`lastSequence` is strictly greater than the previously accepted snapshot.
Hydration copies `session.model` / `session.thinking` from `getSession` and
prefers the latest assistant turn so reopening an older chat keeps that
session's last used model and thinking instead of the globally last-selected
composer values. Reconnect still unions an in-flight session's existing messages onto that
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

`packages/ui/src/apps/pi-session-store.ts` owns the active connected runtime's
session cluster: one event stream, `reducer.bySession`, `hydratedSessionIds`,
the runtime generation guard, and a separate `directory` focus pointer for the
sidebar list and new-session cwd. The cluster lives until a runtime switch,
`clear()`, or `dispose()`; switching the focused project is a pointer change
that never disposes the stream, drops hydrated sessions, or rewrites
`hydratedSessionIds`. The runtime generation advances on bootstrap / reconnect /
runtime switch / dispose; the focus generation advances on every
`focusProject` call so a stale promise cannot commit while a newer folder
focus is already in flight.

### Topic-bus notify contract

`PiSessionStore.subscribe(listener, topic?)` registers a listener on one of
four topic keys; `commitEvents` and other writers publish one notification
per topic they touch so a token delta in session B does not wake session A
chat transcript selectors.

- `session:{id}` — that session's reducer record changed.
- `catalog` — `state.catalog` identity changed.
- `chrome` — cluster UI: `connection`, `error`, `directory`,
  `selectedSessionId`, `sessions[]`, `sessionsListStatus`,
  `focusPending`, `hydratedSessionIds`.
- `*` (default) — broadcast every commit, for tests and legacy callers.

`commitEvents` walks the event batch and collects the session ids whose
reducer record changed; it emits `session:{id}` for each and `catalog`
iff `nextCatalog !== prevCatalog`. Catalog helpers (`applyLifecycleChange`,
`applyHydratedChange`, `markDirectoryLoading`, `markDirectoryFailed`,
`applyDirectoryListToCatalog`, etc.) are reference-stable no-ops, so the
catalog gate is a tight contract. `commitEvents` never emits `chrome` on
the token path. Every other writer that mutates the catalog must capture
`catalogChanged` **before** assigning `state.catalog`; the catalog gate
is `nextCatalog !== this.state.catalog`, and after the assignment the
two are always equal.

Reset / dispose / runtime wipe broadcast the empty state to every topic
bucket so mounted UI sees the reset before the listener sets are torn
down; `dispose` may clear listener sets after the final broadcast.

### Folder switch loading contract

A folder click cannot flash `ChatEmptyState` or an auto-open blank chat.
The chat surface already shows the existing PiChamber logo loader when its
selected id is not yet in `hydratedSessionIds`; `focusPending` extends that
loader preconditions to a folder switch without a known id, and
`sessionsListStatus` lets the chat distinguish loading / ready / failed.
`focusPending` is set the moment a folder click swaps the pointer and clears
only when the selected id becomes hydrated, the focus resolves to an
authoritative empty `sessions[]`, or the focus fails outright. While
`focusPending` is true, `AppEffects` keeps the existing UI store identity so
the chat does not collapse back to `ChatEmptyState`.

Warm folder switches skip the loader: if the preferred session id is already
in `hydratedSessionIds`, `focusProject` selects it immediately and resolves
the list in the background. `PiSessionProvider` seeds `start({directory})`
with the cluster's `lastSelectedSessionForDirectory(directory)` hint so a
warm folder change lands the user on their remembered session with no
spinner.

### List failure vs empty success

A folder-B list is retried exactly once on transient `DAEMON_UNAVAILABLE`
or 5xx/408/429 before the focus slice flips to
`sessionsListStatus: 'failed'`. Failed focus keeps the cluster, the stream,
the previous folder's transcripts, and the focused `directory` intact; the
chat's existing "Session could not be loaded" block exposes **Try again**,
which re-runs `focusProject`. A successful empty list is the distinct
`'ready'` case with `sessions: []` and no error, so an empty new project can
auto-open its draft without flashing a failure banner.

### First-attach race

`hasClusterAttached()` is `stream !== null || connection === 'ready'`. Once
the cluster enters the `'ready'` window — after the list resolves and
during the SSE-plug window — a project click routes through `focusProject`,
not `start` / `open`. Folder changes during that window do not bump
`runtimeGeneration` and never dispose a soon-to-be-stream. The first-attach
`open()` keeps `connection: 'loading'` while the cluster is genuinely
uninitialized; it flips to `'ready'` once the list resolves, and the chat
surfaces use that flag to gate the loader.

### LRU eviction

Idle transcripts are evicted by a deferred microtask scan after both
`commitHydratedSession` and `commitEvents`. The scan walks resident
sessions by `lastAccessById` (a per-process monotonic clock) in ascending
order and drops the longest-idle until the cluster is at
`PI_TRANSCRIPT_EVICTION_SOFT_CAP` (default 16). Selected, busy/retry, and
pending-prompt sessions are protected; `lastSequence` for evicted sessions
is retained so a later rehydrate resumes from the same cursor. The scan
never runs on the hydrate acquisition path — a render mounting many
entries schedules one scan, not one per entry.

### Reconnect catch-up

`reconnect()` merges the snapshot into the existing cluster (no disposals)
and then iterates any hydrated resident whose `lastSequence` is behind the
resumed cursor, issuing a `getSession` and `commitHydratedSession` for each.
A quiet background turn does not lose the disconnect gap.

### `ensureHydrated`

`store.ensureHydrated(id)` hydrates a session if it isn't already resident,
without changing `selectedSessionId` or the directory focus. Chat surfaces
that mount a child session inside a tool part use it instead of `select`,
so background hydrations don't steal the visible chat.

`open(directory, sessionId)` is the first-attach entry: it selects the daemon
project, probes health, lists and hydrates the selected session, and attaches
the runtime-wide stream. The health and list results from that first attach
are passed into hydration rather than probed/listed a second time. After attach, `open` /
`start` /
`legacy-ui-client.setDirectory` / `setActiveSession` route to
`focusProject(directory)` when the cluster is attached, then call
`select(sessionId)` for the new pointer. Same-folder selects remain pure
pointer changes on the resident cluster. Cross-folder
selects swap the list, change the pointer, and hydrate only the new id if it
wasn't already resident.

A `select(project)` that brings the directory into focus calls
`selectProject` (kept for the daemon focus identity used by `listSessions` and
`createSession`); prompt/abort paths already go through
`activateSession(sessionId)`, so a background run keeps its own cwd even when
the focus pointer leaves its folder.

The chat surface waits on `hydratedSessionIds` before painting a session,
so a cached or event-partial transcript cannot flash thinking-block animations
while `getSession` is still merging. The chat body itself remounts with
`key={sessionId}` so composer drafts and viewport anchors reset to the right
session even when the cluster preserves resident transcripts during a folder
switch.

The global session store separately retains authoritative per-directory snapshots for every added project; switching the active Pi runtime directory must not erase unrelated project sessions. The mounted provider follows the
persisted PiChamber project store; with no project selected it connects the
runtime cluster without adopting the daemon process cwd or the filesystem home
as a visible project, so chrome is `ready` with an empty folder focus instead
of remaining on `loading`. `App.tsx`, `MobileApp.tsx`, and `ElectronMiniChatApp.tsx`
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
off the loading state. Selection catalogs (composer, session defaults, small
model, walkthrough model) include only authenticated providers that have
models. Users can hide individual models from those catalogs in Providers
settings; hidden models stay out of pickers. Session default, small-model, and
walkthrough-model pickers live on the Sessions page and use the same picker as
the composer. Providers settings still lists the
full catalog so unconfigured providers can be logged in. Composer chrome does not expose an OpenCode agent selector.
Chat, sidebar, and composer mutations go through `PiSessionStore` and `/api/pi/*`. Pi assistant projections preserve their owning user-message id end to end because the restored chat renderer groups assistant output into user turns by that identity. Tool parts preserve input, cumulative partial output, final output, error text, metadata, and start/end timestamps through the reducer. `pi-to-renderable` keeps that contract for live and expanded tools; settled historical tools whose output or patch exceeds a character budget become preview stubs (`state.deferredBody`) so transcript records do not retain full bodies. Expanding a tool hydrates the canonical part through `useSessionReducerPart`. A completed tool needs an end time and keeps its status verbatim, including `cancelled`.
Settings chrome is the restored PiChamber hub limited to Pi-owned pages
(Providers, Skills, Snippets, Behavior/`AGENTS.md`, Magic Prompts, appearance
and other PiChamber pages). A failed daemon probe must show an error banner,
never an empty idle session list.

Native resource discovery is projected from Pi's resource loader without filesystem paths. Skills are browse-only; Pi prompt templates and applicable global/project instruction files are edited only through opaque daemon identifiers. Project-local resources remain hidden until the browser makes an explicit persisted Pi trust decision; extensions remain disabled by the daemon.

Provider discovery is projected from Pi's model runtime without credentials.
The mounted Providers surface submits API keys once through the authenticated
adapter or renders Pi's opaque browser/device/manual-code login state; stored
credentials never return to the browser. Custom OpenAI-compatible providers
are written through the same adapter to Pi `models.json`; configuration
responses omit credentials and headers, which are write-only. PiChamber new-session model, per-model thinking, small-model, and walkthrough-model
defaults live in its own sidecar and are edited on the Sessions settings page
with the shared model picker. Default thinking is stored per `provider/model`
and applied on session create and composer model changes, clamped to that
model's Pi `thinkingLevels`. A leftover global `defaultThinking` is only a
clamp fallback when no default model is set. Providers settings owns
authentication and the catalog, not those defaults. `providers.list` projects
Pi `getSupportedThinkingLevels` (`off` through `max`, with `xhigh`/`max`
opt-in and `null` map entries hidden). Only the explicit new-session
overrides are passed to the daemon, so Pi's normal settings fallback remains
authoritative otherwise. Composer thinking next to the model name is driven
from catalog `thinkingLevels` (hidden when the model only offers `off`).
Choosing a level updates the composer override immediately and calls
`sessions.setThinking` for an open session; a failed write rolls back the
override instead of looking like success. Unset/Default does not invent a
level. Opening an existing session restores the composer to that session's
last used model and thinking (latest assistant turn, then live
`session.model` / `session.thinking`) instead of the globally last-selected
model. The user can still change them manually; existing session thinking
then stays until the user changes model or thinking.
Composer attachments are uploaded before prompt dispatch and the returned opaque identifiers are forwarded with that captured send. Attachment uploads return opaque identifiers; their temporary paths cross only
the private daemon IPC and are redacted from public transcript/event output.
The browser never receives a path, endpoint, credential, or daemon identity.
