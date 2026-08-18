# Sync architecture, event handling & store update rules

## Scope

This document covers the current client-side session/data architecture in `packages/ui/src/sync` and the rules for updating stores safely.

There are **two distinct session data scopes** in the UI:

1. **Pi runtime-scoped session store** (`PiSessionProvider` / `PiSessionStore`; OpenCode SSE child stores are not session truth)
   - Owned by `PiSessionStore` via `pi-session-context.tsx` and the restored UI-facing sync hooks
   - Cluster source for live session/message/part state across the connected runtime: a single event stream, one `reducer.bySession` map, one `hydratedSessionIds` set
   - Backs the focused project's sidebar list, the chat timeline, and the in-flight busy/retry panels for every resident session
   - Folder focus swaps the sidebar list pointer without touching the cluster; only `clear()` / `dispose()` / runtime switch resets the cluster
   - Backed by `/api/pi/*` and the Pi event stream
   - Read via hooks like `useSessions()`, `useSessionMessageRecords()`, `getSyncSessions()`

2. **Global sessions cache**
   - Owned by `packages/ui/src/stores/useGlobalSessionsStore.ts`
   - Shared source of truth for the Sessions sidebar global lists and Session Retention cleanup
   - Holds:
     - global active sessions
     - global archived sessions
     - active sessions indexed by directory

These two scopes are intentionally different, but they are no longer equal peers for live UI truth.

### Why both exist

The Pi runtime-scoped store is **not** a complete global view.

- It is created lazily for each connected runtime
- It only hydrates sessions the user has visited (subject to the soft eviction cap)
- It is optimized for live, in-flight session data across the cluster
- It does not maintain the complete global active+archived session view needed by the sidebar's cold directories and retention settings

So:

- Use the **Pi runtime-scoped store** for live session/message state on the connected runtime, including background busy sessions the focused folder does not own
- Use the **global sessions store** for cold/global session coverage (especially archived pages and unopened directories)
- Use **aggregated child-store sessions and the global live status index** for live truth across initialized directories

### Runtime-scoped sessions

The Pi cluster belongs to the connected runtime, not the focused project:

- One event stream, one `reducer.bySession`, one `hydratedSessionIds` set, and one runtime generation guard
- `directory` is a focus pointer for the sidebar list, the new-session cwd, and the `selectProject` daemon focus — not a liveness boundary
- With no PiChamber project selected, `connectWithoutProject()` probes `/api/pi/runtime` and sets `connection: 'ready'` with a null folder focus. It does not adopt the daemon cwd. Leaving `connection` at `'loading'` is reserved for an in-flight first attach, not for "no folder yet".
- Folder focus (`focusProject(directory, preferredSessionId?)`) replaces the `sessions[]`, sets the `selectedSessionId`, hydrates the new id only when cold, and never disposes the stream, clears `hydratedSessionIds`, drops other folders' hydrated transcripts, or rewrites `connection: 'loading'` for the cluster
- Folder focus sets `focusPending: true` while the list is in flight so the chat can keep its existing view (or its existing PiChamber logo loader) instead of clearing back to `ChatEmptyState`. `sessionsListStatus` distinguishes `'loading'` / `'ready'` / `'failed'` and discriminates authoritative empty success from list failure
- Same-folder selection is a pointer change on the resident cluster (`select(id)`)
- A failed list for the new folder surfaces an error on that slice only after one automatic retry on transient 5xx / 408 / 429; previous folder sessions, the stream, and other folders' hydrated transcripts all survive
- Warm folder switches skip the loader: if the preferred id is already hydrated, `focusProject` selects it immediately and resolves the list in the background. `start({directory})` also seeds the focus with `lastSelectedSessionForDirectory(directory)` so the chat reopens on the remembered session with no spinner
- Idle transcripts are evicted by a deferred microtask scan (default cap 16) that walks `lastAccessById` in ascending order and never evicts the selected, busy/retry, or pending-prompt session; it keeps the evicted session's `lastSequence`, never runs on the hydrate acquisition path, and is scheduled after both `commitEvents` and `commitHydratedSession` so a render mounting many entries scans once, not once per entry
- `applyPiEvent` only clones the session the event touches; other resident sessions keep their previous references so a background busy turn does not rebuild the visible transcript tree
- `ensureHydrated(id)` hydrates a session if cold without changing `selectedSessionId` or directory focus — chat surfaces that read a child session inside a tool part must use it instead of `select`, so background hydrations never steal the visible chat
- `prompt()` must not replace a resident transcript with an empty busy stub. Live events only carry the new turn; installing a blank `bySession` row makes prior history disappear. If the row is missing or has no messages, re-hydrate from `getSession` first. `hydrate()` also refetches when `hydratedSessionIds` still lists the session but `bySession` has no messages. A live event for a session whose transcript was dropped but whose `lastSequence` cursor remains triggers the same restore and merges the fetched log onto the in-flight turn; a prompt waits for that restore before dispatching
- Reconnect merges the snapshot into the existing cluster without disposals, then hydrates any resident session whose `lastSequence` is behind the resumed cursor so a quiet background turn does not lose the disconnect gap

## Ownership map

| Layer / Store | Owns | Scope |
|---|---|---|
| `ChildStoreManager` and child directory stores | Priority-scheduled directory bootstrap plus `session`, `message`, `part`, `permission`, `question`, etc. | One runtime and one store per directory |
| `SessionMessageLoader` | Initial message loading, pagination, prefetch, retries, load state, and optimistic reconciliation | One runtime, directory, and session ID |
| `pi-session-catalog.ts` | Live runtime-scoped metadata catalog (`byId`, `byDirectory`, `listStatusByDirectory`); the at-most-2-in-flight directory refresh scheduler | All known directories in the active runtime |
| `PiSessionStore` (`pi-session-store.ts`) | Live event stream, reducer `bySession` (LRU-capped transcripts), `hydratedSessionIds`, `lastAccessById`, the live catalog, and per-directory refresh generation | One runtime-wide cluster |
| `PiSessionCatalogFeeder` (`pi-session-catalog-feeder.tsx`) | Subscribes to `useProjectsStore` + `useSessionUIStore`; fills the catalog for every known directory (project roots + worktrees), deduped by sorted signature | All known directories; React-mount lifecycle |
| `global-session-status.ts` | Incremental non-idle session status index reconciled from events and authoritative directory snapshots | All known directories in the active runtime |
| `session-ordering.ts` | Ephemeral lifecycle rank used by every user-visible session list | All known sessions in the active runtime |
| `session-activity-timing.ts` | Elapsed time of the running turn and of the turn that just finished, plus the persisted starts that survive a reload | All known sessions in the active runtime |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Thin wrapper that reads the catalog via `liveSessionRecordToUiSession`; retains `upsertSession` / `removeSessions` / `archiveSessions` / `applySnapshot` / `resetForRuntimeSwitch` until `migrate-hooks` retires it | Derived view of the catalog; mutations for retained callers |
| `known-session-directories.ts` | The shared `buildKnownSessionDirectories(projects, worktrees)` helper the sidebar and feeder use to agree on the directory set. Dedupe is case-insensitive; returned paths keep filesystem casing for daemon list RPC | App-wide |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `attachment-files.ts` | Attachment picker allowlists, MIME/content validation, structured-text sanitization, and HEIC conversion | Local chat attachments across shared UI runtimes |
| `document-attachments.ts` | Bounded Office/OpenDocument extraction, document text serialization, embedded-image extraction, and positional citations | DOCX, PPTX, XLSX, ODT, ODP, and ODS chat attachments |
| `input-store.ts` | Draft input state, attached files, synthetic parts | App UI state |
| `selection-store.ts` | Per-session model/agent/variant cache; opening an existing chat restores from the hydrated Pi session, not `lastUsedProvider` | App UI state |

Local chat attachments are normalized by `attachment-files.ts` before entering `input-store.ts`. PNG, JPEG, GIF, WebP, and PDF retain their media type; HEIC/HEIF is converted to JPEG; recognized text/code formats and unknown files whose first 4 KB are text are sent as `text/plain`; binary files outside the supported media types are rejected. Jupyter notebooks become readable markdown with non-text outputs omitted. HAR credentials, cookies, and sensitive URL parameters are redacted, while request/response body text is omitted. SVG and Draw.io files are attached as source text, not executable/rendered content. Browser and VS Code pickers expose the same allowlist, while drag-and-drop may still accept an unknown extension after content inspection.

Office and OpenDocument packages are metadata-validated before asynchronous extraction, with limits of 20 MB compressed input, 5,000 archive entries, 25 MB per entry, 8 MB per XML part, and 100 MB total uncompressed content. Unsafe or non-canonical archive paths reject the whole attachment, and only XML, relationship, and supported image entries are decompressed and retained. Extracted text, including its explicit truncation notice, is bounded to 2,000,000 characters. At most 50 signature-validated PNG, JPEG, GIF, or WebP images and 40 MB of image bytes are retained, with a 20 MB per-image limit; unsupported, invalid, omitted, and truncated content remains explicit in the extracted text. Images whose citations fall beyond text truncation are not attached. Extracted document content remains a `text/plain` file attachment with the original document filename, rather than becoming visible user-message text. Supported embedded images become separate image file parts; the extracted text contains `[filename]` citations at the source paragraph, slide object, spreadsheet cell anchor, or OpenDocument text position. Generated image filenames are re-evaluated if the composer changes during asynchronous preparation, avoiding collisions. The store publishes all generated parts atomically only after every data URL is ready.

The composer compares normalized attachment MIME types with the selected model's declared input modalities. It warns when a newly attached file or an existing attachment after a model change requires an unsupported modality, but does not block sending. Missing modality metadata remains unknown and does not produce a warning. Pi sends upload every captured data URL before prompt dispatch and forward only the returned opaque attachment ids; dropping `files` is not a supported fallback.

## Live session catalog

`PiSessionStore` owns the runtime-scoped live catalog of every Pi session the connected runtime has surfaced. Transcripts continue to live in `reducer.bySession` (LRU-capped, soft cap 16, idle-eviction on the deferred microtask). The catalog is metadata-only — no messages, no parts — so it can survive an LRU drop and still render a sidebar row.

### Shape

```text
catalog.byId:                    Map<sessionId, LiveSessionRecord>
catalog.byDirectory:             Map<directory, sessionId[]>     // membership
catalog.listStatusByDirectory:   Map<directory, 'idle'|'loading'|'ready'|'failed'>
```

`LiveSessionRecord` carries `id`, `directory`, `parentId`, `title`, `archived`, `createdAt`, `updatedAt`, optional `preview` / `messageCount`, a `lifecycle` mirror (`'idle' | 'busy' | 'retry' | 'error'`), and a `hydrated` flag (a pointer into `reducer.bySession`, not a copy of it).

### Membership rules

- A successful `listSessions` for directory `D` replaces `byDirectory[D]`; other directories are untouched. Rows for ids that left `D` are removed from `byId` only when no other directory in the catalog still owns the record (a session that has moved A → B must keep its B row when A is re-listed without it).
- A failed `listSessions` for `D` keeps the prior rows for `D` and flips `listStatusByDirectory[D]` to `'failed'`. Failure is not empty success.
- Pi events update rows in place: `session.lifecycle` flips `lifecycle`. `session.updated` writes `title` without bumping last-prompt recency. A user-message start from another device stamps recency and fills an empty stub title from the prompt text so a remote first send is not stuck as "Untitled Session". Token deltas and lifecycle/snapshot boundaries do **not** bump `updatedAt`. Last-prompt recency is written by `PiSessionStore.prompt()` on this client and by remote user-message starts via `touchRecordUpdatedAt`.
- An event arriving for a session that has not been listed yet (`byId` has no row) inserts a `upsertStubRecord` so the sidebar can render the session as busy. `applyDirectoryListToCatalog` preserves a non-idle existing lifecycle on listed ids, so a stub is never downgraded to idle by a slow list.

### Single fill path

`PiSessionCatalogFeeder` is the only direct caller of `PiSessionStore.refreshAllDirectoryCatalogs` from React. It subscribes to both `useProjectsStore` (project roots) and `useSessionUIStore` (`availableWorktreesByProject` for discovered worktree paths). On every change in the union it:

1. Computes the sorted directory-set signature.
2. Skips the refresh when the signature has not changed (project-list reorders and worktree discovery that yields the same paths must not re-list).
3. Waits until the focused directory is connected and its list/hydration demand has settled, so background directories cannot occupy the interactive request path during a runtime or folder switch.
4. Otherwise calls `PiSessionStore.refreshAllDirectoryCatalogs` only for directories whose catalog status is not already `'ready'`.

`refreshDirectoryCatalog` is the single fill primitive. It captures a per-directory generation, bumps it on every call, and ignores stale completions (a slow RPC returning after a newer refresh has begun, or after a runtime switch, commits nothing). The at-most-2-in-flight scheduler is owned by `pi-session-catalog.ts` (`mapDirectoriesWithRefreshSlot` uses `mapWithConcurrency(2)`; the older nested `withDirectoryRefreshSlot` is exported only for direct callers and must not be re-nested — two limiters can deadlock).

### Wrapper contract (until retire-duplicates)

`useGlobalSessionsStore` remains a thin wrapper for retention/pin metadata and mini-chat fill. Sidebar, header, command palette, archive, and mobile session lists read `catalog.byId` / `catalog.byDirectory` through `useCatalogUiSessions` / `useSession` / `useSessionStatus`. `useSessions()` is the focused directory slice; `useAllLiveSessions()` / `getSyncSessions()` are the runtime-wide active catalog.

`listUiSessionsFromCatalog` treats an omitted or `undefined` `directory` as runtime-wide. `null` or `''` is an empty focused slice (`useSessions()` when the cluster has no directory). A non-empty string is that directory's membership. The React hook always passes `{ archived, directory }`, so `undefined` must not be treated as empty.

The wrapper still skips sync when the focused folder's list is still in flight (`connection === 'loading'`, `focusPending`, or `sessionsListStatus` `'loading'`/`'idle'`). Mini-chat (no feeder) still reaches `loadSessions`. `fetchDirectoryPages` reads `'ready'` directories from the catalog and only refreshes `'idle'` / `'failed'` directories.

### Failure handling

Per-directory failures stay scoped to that directory. The catalog's `listStatusByDirectory` carries the signal without leaking into `state.connection` (which is owned by the bootstrap / reconnect path). A failed list does not erase other directories' rows.

### Runtime switch

`dispose` / `clear` / `resetForRuntime` reset the catalog via `initial()`. The `hydratedSessionIds` set, `lastAccessById`, and the per-directory refresh generations all clear in lockstep.

## Session list rules

### Directory bootstrap scheduling

`ChildStoreManager` is the single owner of directory bootstrap scheduling. Consumers publish demand; they must not start bootstrap from row mount effects.

- The scheduler runs at most two directory bootstraps concurrently.
- Selected session/current directory demand outranks active-project, expanded, visible, and background demand.
- Demand is deduplicated by normalized directory and can be promoted while queued.
- The complete known project/worktree set is always published. Collapsed and off-screen directories remain background demand, so they refresh eventually rather than waiting for expansion.
- A bootstrap holds its scheduler slot through critical state and the authoritative directory session-list fetch. Deferrable command/MCP/LSP/VCS/question/permission enrichment starts afterward without extending slot ownership or competing with the initial session-list request.
- A system-resume signal, including Capacitor foreground resume, refreshes pending questions and permissions only for the active materialized directory. The refresh is deduplicated while in flight, preserves existing state on fetch failure, and leaves unopened directories untouched; normal stream reconnect recovery remains the broader catch-up path.
- When a materialized current turn contains a pending/running question tool but that session's pending question record is missing, the mounted chat performs a question-only recovery scoped to that session. It tries at most three times with delays of 0, 500, and 1,500 ms, stops when the chat unmounts or changes sessions, and guards every attempt against runtime changes. This closes cold-start races without adding requests to ordinary session opens or scanning unrelated sessions and directories.
- A mounted directory-store consumer pins that store for its lifetime. Eviction may dispose only unmounted directories, so optimistic actions and realtime events cannot move to a replacement store while visible React consumers remain subscribed to an older identity.
- Reconfiguration and runtime switching invalidate stale generations. A stale completion must not publish state into the new runtime.
- Failure is recorded as `failed`; it is not converted into a successful empty snapshot. Forced demand can retry failed or completed work.
- A failed bootstrap is classified as `os-permission` only when the owning runtime filesystem API independently confirms `EPERM`/`EACCES` for that exact directory. OpenCode/proxy error text is never used as permission evidence. The scheduler retains the directory-scoped reason so local Desktop can offer native folder selection before a forced retry.

Bootstrap remains stale-while-revalidate: a directory store may paint persisted sessions immediately, but only a successful authoritative fetch may replace that cached list.

Directory session lists record whether their current snapshot is empty, persisted, live-event-derived, or authoritative. Bootstrap captures a mutation revision before starting its requests. Its completion replaces persisted data, including with a successful empty response, then overlays only session events and direct move/archive/delete mutations newer than that revision. It must not preserve the entire cached list as a race fallback because that would retain stale persisted sessions.

The roots request is authoritative for root completeness. The broader child-session request has independent completeness: a successful empty response clears stale children, while a failed request preserves known children and their required ancestors without turning the failure into an empty snapshot.

The persisted session snapshot keeps up to 50 sessions selected by `time.updated`/`time.created`, not ID ordering. Non-empty updates coalesce to the latest runtime-directory snapshot and flush on lifecycle suspension; runtime switches reject stale pending writes. Successful empty results persist an empty v2 tombstone synchronously so legacy data cannot reappear on restart. If localStorage quota prevents the full snapshot, persistence retries with progressively smaller recent snapshots and removes stale current/legacy values rather than leaving an old list indefinitely.

### Directory-scoped session list

Use the directory-scoped sync store when the UI needs the live session list for the **current directory**.

Examples:

- current chat/session switching
- per-directory session/message bootstrap
- session/message/part SSE updates

Directory bootstrap must publish a closed session hierarchy: when a child is
returned before the roots query catches up during cold startup, retain or
recover its referenced parent instead of exposing an orphan-only snapshot.

Session message loads use runtime, normalized directory, session ID, SDK epoch, and loader generation as commit authority. Eviction, archive, delete, move, directory disposal, and runtime switching invalidate the applicable loader generation before stale in-flight work can publish. A move invalidates both source and destination loader targets.

An authoritative `session.deleted` event also clears persisted UI state before routing metadata can be removed. Confirmed local deletion and accepted `404` deletion do the same directly instead of depending on the event echo. Cleanup is identity-owned by runtime, normalized directory, and session ID: queued messages, persisted todos, composer drafts, inline-comment drafts, and pins clear only that tuple, while the active runtime's folder store removes the session from every active or archived folder scope. Stale-runtime events and unresolved/global directory identities do not mutate persisted state.

Persisted sidebar state is never reconciled destructively from the first successful startup list. That list establishes an authoritative active+archived baseline. Only a session present in that baseline and omitted from a later complete snapshot is treated as a missed external deletion. Archive and directory moves retain the session ID across snapshots and are not deletion cleanup. This favors harmless hidden stale metadata over irreversible user-state loss when startup data is incomplete.

Session materialization recency is keyed by runtime and directory. Foreground loads and successful prefetches participate in the same bounded per-directory session LRU. Prefetch pagination metadata has a global count ceiling and is removed with session eviction, directory disposal, loader runtime reconfiguration, and loader disposal.

### Global session list

Use `useGlobalSessionsStore` when the UI needs a **shared global session cache**.

Current consumers:

- `useSessionAutoCleanup.ts`

### Live cross-directory session/status view

Use the sync hooks backed by aggregated child stores when the UI needs **live truth** for sessions or statuses across all initialized directories.

Current consumers:

- `SessionSidebar.tsx`
- `SessionNodeItem.tsx`
- `Header.tsx`
- agent/session activity surfaces using `useGlobalSessionStatus()` / `useAllSessionStatuses()`

Cross-directory selectors subscribe to the narrow child-store field they aggregate. Session aggregation listens to `state.session`. Live busy/retry state is also maintained in `global-session-status.ts`, where each row subscribes to one session ID instead of scanning every child store. Events update the index incrementally; authoritative per-directory status snapshots seed it, clear sessions omitted as idle, and reconcile missed events. Unrelated streaming events such as `message.part.delta` must not trigger global session/status scans.

Session display order is last-prompt recency, not last turn stage. `session-ordering.ts` promotes a session only when `observeSessionActivityEvent` sees a new `active` phase (the send path). Settled/idle, hydrate replay, reconnect snapshots, and list `time.updated` stamps do not promote. Pins remain the first ordering bucket. The timestamp/creation fallback is frozen when a session first participates in ordering; creation time and ID provide deterministic ties. Runtime switches clear all phases, baselines, and ranks.

`session-activity-timing.ts` measures how long a turn has been running, because `SessionStatus` carries no timestamps. It is driven from the same two write paths as `global-session-status.ts`, so a row can never count a turn that index calls idle. A session gains a start on its first `active` observation and keeps it across repeated busy/retry events; settling converts that start into a finished duration used by live running rows. Unread completion is a separate `turn-complete` notification: Pi lifecycle `idle`/`error`/`interrupted` after a live `active` turn appends it for any session that is not currently open, and opening the session marks it viewed.

Sending a prompt promotes that session immediately (`observeSessionActivityEvent('active', reorder)` plus a catalog `updatedAt` bump). Finishing or switching sessions does not reorder. Status dots still follow catalog `lifecycle` (`idle` when the agent is done).

A provider stream that ends without `finish_reason` publishes `session.error` and must complete the in-flight assistant (duration, running tools) so the chat does not stay on "Analyzing". The next send is a new turn even if the UI still tried steer/follow-up.

Starts are persisted so a reload resumes the same count, but a persisted start is a lookup table and never a claim of activity. **Nothing in the protocol marks where a turn begins.** OpenCode calls `SessionStatus.set` with `busy` at every step of the agent loop and publishes an event each time, so a busy event means "still running", not "just started"; after a refresh one of those repeats normally beats the first status snapshot, so treating it as a turn boundary reset the counter on nearly every reload. Turn *ends* are marked — `session.idle` and `session.error` fire once, live, and retire the persisted record — while a snapshot that omits a session is not evidence of anything, since it may simply not see it yet.

That leaves the case with no observable answer: a turn that ended, and another that began, entirely while the tab was gone. Two bounds stand in for the evidence the client cannot have. A liveness stamp sits beside the start — refreshed while the session is observed active, at most every 15s, and stamped precisely as the page hides (`pagehide`/`visibilitychange`/`freeze`, written immediately rather than through deferred storage so it cannot lose that race) — and is compared against this page's `performance.timeOrigin`, so the measure is how long the app was absent rather than how long bootstrap took; a 20-second startup must not spend the allowance. Records may only be adopted within 90s of load, after which they are discarded — a backstop for a runtime whose event stream is down and where snapshots are therefore the only signal. A runtime switch resets the module, since the previous instance's turns are not ours.

Reconciliation walks the running turns and asks the snapshot whether it covers each one, rather than being handed everything the snapshot covers. Only a live start can settle, and there are a handful of those against a directory's hundreds of sessions, so the pass stays proportional to the timing work and allocates nothing per poll. Malformed, wrong-shaped, over-age, and future-dated entries are rejected on read. The payload is not runtime-scoped: records live for seconds and are keyed by instance-unique session IDs, whereas the runtime key is derived from injected globals and is not guaranteed stable across early startup — a read under a key the previous page never wrote to is indistinguishable from "no turn was running".

**Only the stamp expires a persisted start.** A snapshot that covers a session without reporting it busy is not proof the turn ended: bootstrap fetches status and sessions in parallel and directory scopes resolve at different times, so a snapshot legitimately arrives before it can see a running session. Treating one of those as a settle deleted the start moments before the real busy snapshot arrived, which reset every counter to zero on reload. Settles therefore act only on sessions that already have a live start in this page session.

The active-session watchdog in `sync-context.tsx` (per-directory status polls and child-session discovery lists) runs its network calls through the shared background-network gate in `@/lib/background-network`, alongside poll-shaped git reads, global session pages, and command/skill discovery. Background fan-out must stay under that gate so the browser's per-origin connection pool keeps free sockets for interactive traffic — an uncapped startup burst previously queued the first session-open message fetch for seconds.

Imperative cross-directory session lookups use the cached ID index from `getAllSyncSessionMap()`. The index is rebuilt only when a child store's `state.session` reference changes; permission lineage checks must reuse it instead of rebuilding a full session map per call.

VS Code does not run the server permission-auto-accept runtime. The extension host persists and broadcasts authoritative policy, while its foreground UI runtime resolves missing child-session lineage through the OpenCode API before deciding whether to suppress and answer a `permission.asked` event. Once policy is enabled, a live `permission.asked` event sends the directory-scoped `permission.reply` immediately and does not block on a permission-state preflight request. Enabling the policy treats permission cards already present in the directory store the same way and replies immediately, then reconciles the server's pending list with a state preflight so stale already-resolved requests are not replied to or resurrected. Reconnect/bootstrap also uses the preflight while reconciling pending requests in the session directory, including requests inherited by child sessions. Unknown lineage and exhausted reply retries fail closed and leave the request available for manual action. A later `permission.replied` event invalidates any older deferred ask so the async policy check cannot resurrect a resolved request. With every PiChamber webview closed or suspended no responder runs; this is an intentional VS Code limitation. Other runtimes remain fully server-owned.

### Mutation responsibility

`useGlobalSessionsStore` is kept correct by:

1. shared global fetch/reconciliation via `loadSessions()` / `refreshGlobalSessions()`
2. session create/update/delete events; recency-only updates for existing sessions are retained latest-per-session and committed once on `session.idle`/`session.error`, while structural updates and create/delete remain immediate and runtime switching discards pending updates. Display ordering reacts separately to active/settled lifecycle transitions, not to these recency publications
3. direct mutation from session actions after successful SDK calls:
   - create
   - title update
   - share
   - unshare
    - archive
    - delete
    - move to another worktree directory
   - retention cleanup batch archive/delete

This keeps cold/global lists responsive without requiring a refetch after every change.

Live activity/status indicators must not depend on this cache. They must use the event/snapshot-reconciled global live status index.

`usePiSessionSnapshot` caches by store snapshot identity. Selectors that close over a session or message id will keep returning the previous entity when the store has not emitted. Subscribe to the collection (`reducer.bySession`, `sessions`, `hydratedSessionIds`) and look the id up in the hook body.

## Session message loading

`SessionMessageLoader` is the shared authority for session message requests. Navigation, reactive chat loading, sidebar prefetch, pagination, reconnect/recovery, and optimistic reconciliation must delegate to it rather than issuing parallel initial requests.

Rules:

1. Request identity is runtime key + normalized directory + session ID. Session IDs alone are not globally unique across runtimes or directories.
2. One in-flight request is shared by all callers. Foreground demand may promote the visible load kind of an existing prefetch without starting another request.
3. Load state is explicit per session: `idle`, `loading`, `ready`, or `error`. Fetch failure preserves prior materialized records and exposes retry; it never becomes authoritative empty success.
4. Async commits are generation-checked. Runtime switches, forced refreshes, eviction, and disposal must reject stale completion.
5. Prefetch coverage and persisted directory data are runtime-scoped. Legacy persisted directory entries may seed startup continuity, but they are not live truth.
6. Message and part materialization preserves references for unchanged records and maintains direct message-to-parts lookup. Consumers subscribe to the selected session's records rather than broad message/part containers.
7. Pagination demand must carry the selected session's effective directory. It must not fall back to the sync provider directory because the visible session may belong to another worktree.
8. The ref-stable loader is disposed only after the current task when its provider unmounts. This lets React Strict Mode's development setup → cleanup → setup probe retain a usable loader for child effects, while real disposal still invalidates the preceding lifecycle's work.

Initial loads use smaller pages on constrained VS Code/mobile surfaces. Prefetch resolves only the initial renderable page; it does not eagerly download older history. The mounted chat timeline requests older pages when its viewport is underfilled or the user scrolls toward history, while mobile uses its explicit load-older action. Timeline caches, pending work, prepend snapshots, and stale checks use runtime + directory + session identity so equal session IDs in different worktrees cannot share lifecycle state. Older pages are fetched through the same loader and merged with optimistic records before publication.

## Loading diagnostics

Session loading instrumentation is disabled by default. Set `localStorage.pichamber_session_load_perf` to `"1"`, reproduce the interaction, then inspect `window.__pichamberSessionLoadPerformance.events`. The in-app Performance overlay (Settings → General → Diagnostics, or `?perf=1`) also enables these events for the current browser only.

The bounded event buffer records only controlled bootstrap, message, and global-list operation/caller labels with queue/duration, outcome, retry count, and downloaded record count where applicable. Message-page events also record the requested limit and whether a cursor was present. When diagnostics are enabled, the selected chat records its first painted renderable message snapshot once per recent session identity and immediately clears the corresponding browser performance entry after emitting the trace mark. Canceled frames retain no measured identity, so returning to that session can schedule a replacement measurement; completed identity tracking uses the same 1,000-entry ceiling as the event buffer. Exported events never retain runtime keys, directories, session IDs, credentials, or message content. Initial-message expansion counts every downloaded page, not only the accepted page. The browser profiler independently validates the known labels and finite numeric fields before export. Instrumentation is diagnostic only; unit/type/lint checks do not replace production runtime profiling at representative project/session scale.

High-frequency sync diagnostics are separately disabled by default. Set `localStorage.pichamber_sync_perf` to `"1"` before reload to enable fixed numeric counters for pipeline traffic, reducer publications, streaming reconciliations, entries/messages visited, targeted heartbeat work, and persistence serialization/write volume. The Performance overlay uses the same counters without writing that key. The hot path performs only a boolean check while disabled; counters never retain IDs, payloads, or user content.

Browser profiling also enables `localStorage.pichamber_stream_perf` to capture bounded aggregate timings and render counts for chat projections, message components, and major sidebar boundaries. These metrics contain no session IDs or user content and are reset immediately before each recording. The overlay reads the same aggregates; leave it off during CDP captures so the HUD cannot become the work being measured. See `packages/ui/src/lib/perf/DOCUMENTATION.md`.

The profiler also emits a user-timing mark when pending global-session recency is committed at a lifecycle edge. `summary.json.longTaskAttribution` correlates that mark with enclosing long tasks without recording session data.

Pi streaming `contentIndex` identifies a content block, not an individual delta. Repeated text or thinking deltas for the same block share an index and append in event-sequence order; sequence rejection, rather than `contentIndex`, owns replay protection.

Streaming assistant text is cadence-batched once per animation frame before reaching the markdown renderer. The live tail overlays those parts onto the streaming message only: when part membership is unchanged (same ids/types, and non-text parts keep reducer identity), `buildLiveStreamingEntry` patches that assistant record and leaves `userMessage`, `activityParts`, and sibling assistants at their previous identities so `ChatMessage` memo can skip them. The live turn's user header and settled sibling assistants also skip when those record identities are unchanged, even if `renderMessage` is recreated for the patched assistant. Neighbor `previousMessage` / `nextMessage` compares use message info, not live part text. A new tool/reasoning part, or a replaced tool object, re-projects the turn. The renderer freezes settled leading markdown blocks and re-lexes only the source tail. While the live tail is still the last block, append-only token updates write that text node directly and skip the async block/HTML pipeline. While the message is still streaming, Shiki and KaTeX stay off for every block, and the unstable live tail is a growing text node in a full-width paragraph (normal wrapping, matching CommonMark `breaks: false`) rather than marked/morphdom HTML. Unfinished code fences, lists, and quotes keep pre-wrap. Highlighting and math land on the settle pass. Live thinking auto-expands into a max-height plain-text pane that scrolls internally, then collapses as soon as that thinking part settles (the next text or tool part starts). **Collapsed by Default** off keeps a one-line header during stream and after unless the user expands it. It does not add a second character-pacing timer, which would multiply parse/morph work while catching up on large streamed chunks.

Chat turn `isWorking` (assistant footer visibility) follows `selectStreamingAssistantMessageId` / reducer `streamingMessages`, not catalog `busy`. A session can remain catalog-busy after the live stream id clears; that must not keep the last-turn footer unmounted.

`useSessionMessageRecords` freezes live-tail text, thinking, and tool-part changes by default: it reads the streaming assistant from `selectStreamingAssistantMessageId` (reducer `streamingMessages`) and reuses the previously published records array. ChatContainer, the composer (`useSessionMessages` / ModelControls), the status row, and the context panel all share that hook, so a token must not re-project the whole transcript in each of them. `useUserMessageHistory` uses the same session topic but treats assistant-part mutations as equal so the composer does not rebuild arrow-history from 200 turns on each token. The streaming tail overlays live parts from `useSessionParts`. Pass `suspendPartUpdates: false` only when a caller must see in-flight part bodies in the records array. New messages and historical part edits bust the freeze. Structural Task session identity changes on a non-suspended (historical) message also bust it so a parent can link a newly created subagent immediately. Record publication itself is incremental: `projectSession` plus `piProjectedToRecords` reuse unchanged historical projected messages and record objects, so a token or tool update on the live tail must not remap earlier turns. Freeze prefers `lastMutationKind === 'part'` on the suspended message (O(1)) and only walks historical parts when that signal is missing. `useSessionParts` remaps live parts by reducer-part identity so unchanged tools in the streaming message are not rebuilt on each token.

`useSessionReducerPart` hydrates one reducer part with `mapPart(..., { full: true })` when an expanded tool's render record omitted its body. While expanded it selects that part leaf on `session:{id}` so an unrelated token cannot rebuild the expanded payload. While collapsed it stays off the session topic.

The event pipeline delivers each ordered per-directory flush as one reducer batch. Events retain their individual global indexes, notifications, cleanup, routing, materialization, and debug side effects, while their directory mutations accumulate in order and publish one store transaction per touched directory. Each top-level state slice is cloned lazily at most once in that batch; no-op events do not change references.

Streaming lifecycle derivation has two paths. Directory attach, switch, bootstrap, and reconnect may perform a full reconciliation. Normal store publications reconcile only sessions whose `session_status` or `message` bucket changed; part-only events update the affected streaming message heartbeat directly and must not rescan all busy sessions.

Incomplete-session materialization is deduplicated by runtime, directory, and session for the full cooldown window, including after a fast success or failure. A settled-running-tool recovery may supersede a different request in that window so an earlier pre-settlement refresh cannot consume the only terminal recovery signal. Deferred recovery is dropped if its captured runtime is no longer active. If recovery requests a tail refresh while an older load is in flight, one refresh runs after that load instead of losing the newer authority demand. Completion retains the cooldown marker until expiry, and an older completion cannot clear a newer request marker. Recovery starts after the current ordered event batch and rechecks whether local state already contains the requested entity before starting HTTP. An explicit empty part bucket is authoritative fetched-empty state, not a missing snapshot. This prevents repeated orphan/missing-part events from creating message-tail and status request storms while preserving later recovery.

When `session.idle` or `session.error` settles a session but the trailing assistant message still contains a `pending` or `running` tool, sync refreshes that session tail. This narrowly reconciles a missed terminal tool-part event without refetching normally completed turns or stale tools from older turns. A stale refresh or delayed part event cannot regress a locally observed terminal tool to an active status.

When a session is authoritatively settled — `session.idle`/`session.error` event, or an authoritative status snapshot that lowers a previously busy session — and the trailing assistant message is still *unfinished* (`time.completed` missing) with active tool parts and no pending question/permission, the turn is treated as interrupted (managed OpenCode process died mid-turn; the server never finalizes the parts, see pichamber#2577 / anomalyco/opencode#19023). The active parts are finalized locally as `error`/`Interrupted` with an end time, so tool timers stop and cards render the error state. The mark is gated on an explicit idle status (absent status is "unknown", never judged), never applies while the session is busy (including question/permission waits), and a later terminal event or refresh supersedes it while a stale `running` refresh cannot regress it.

Directory stores also own session-keyed sidecar notification channels for permissions, questions, and message materialization. High-frequency realtime part events annotate the exact session/message before committing, so visible records, user history, renderability, and sidebar permission and question rows are not notified by unrelated sessions. Structural message replacements notify only changed subscribed session buckets; unannotated bulk part replacement conservatively resets active message subscribers so bootstrap, pagination, rollback, and legacy writers cannot leave stale projections.

Message sidecar consumers also filter targeted updates by purpose before notifying React. Suspended live-tail text/reasoning changes do not rebuild visible message records, but structural Task session identity changes bypass suspension so a parent can link a newly created subagent immediately. Assistant-only part changes do not rebuild user input history, and targeted updates that preserve authoritative part buckets do not recheck a session that is already renderable. Message replacements, removed final part buckets, and conservative resets always notify.

## Session directory resolution

`session-directory-resolution.ts` owns the precedence used to answer "which directory does this session belong to". Every send, message fetch, message-queue key, and send-confirmation lookup is routed by that answer, so a wrong value is not a display problem: the prompt is posted against a directory that does not own the session, the request is rejected, and the optimistic message is rolled back with no visible error.

Precedence, highest authority first:

The discriminator is whether the server confirmed the path, not whether the value is local or synced.

| Source | Meaning |
|---|---|
| `authoritative` | The session record's own directory, then a child store that holds it |
| `selected` | Server-confirmed directory captured at selection; a guessed one is never passed |
| `attachment` | Worktree attachment recorded by this client; the *requested* path |
| `worktree-metadata` | Worktree captured when the session was created in one; the *requested* path |
| `remembered` | Per-runtime directory persisted across restarts |

Rules:

1. Ownership comes from the session record's own `directory`. `getSyncSessionDirectory()` reports *containment*, not ownership, and is only the fallback for a record without a directory: a project's session list includes the sessions of its worktrees so the sidebar can group them, so the parent repository holds worktree sessions too, and reading ownership from membership routes a worktree session to its parent. `null` means "not indexed yet", never "no directory".
2. `attachment` and `worktreeMetadata` hold the worktree path this client asked for, before the server canonicalized it. They are a hint for a session sync has not indexed yet, never a correction of a confirmed directory — otherwise a stale local path re-creates the very mismatch this precedence exists to prevent.
3. Never persist or rank a guessed directory. `selectSession` may fall back to the active directory to keep routing usable, but that value is not written to runtime memory, not written to the last-active snapshot, and not passed as `selected` — a persisted guess outlives the race that produced it and survives reloads and restarts.
4. Components must not read `currentSessionDirectory` to build request or queue keys; use `getDirectoryForSession()` so every consumer resolves identically.
5. A disagreement between sources is logged once per session, and `__opencodeDebug.diagnoseSessionDirectory()` reports every source in precedence order.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.
4. Sending after a revert commits the new branch optimistically: remove the reverted tail and marker before inserting the new message, and restore both if the send is rejected.
5. Composer and queued sends carry their captured runtime, directory, and session through asynchronous preparation. A runtime change cancels the send instead of re-resolving it against the new runtime.
6. After session creation, the directory returned by the server is authoritative over the requested draft directory. The server may canonicalize a worktree path, and the first prompt must use the same directory identity as the created session.
7. A prompt send that fails **after** the request left the client is ambiguous, never a definite failure: the server may already be answering it. Transports tag those errors (`markAmbiguousTransportFailure` in `@/lib/relay/transport-error`; the relay tunnel tags every stream that dies with a request in flight), and `isAmbiguousSendFailure` reads the tag before falling back to status/text heuristics. An ambiguous failure waits for the connection to return, refetches recent messages, and confirms the optimistic message in place instead of rolling it back — rolling it back lets the message queue re-send a prompt the engine is already running, producing two independent AI responses for one user message.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` / `archiveSessions()` -> wait for server confirmation, then upsert each archived session
- `unarchiveSession()` / `unarchiveSessions()` -> wait for server confirmation, then upsert each restored session
- `deleteSession()` / `deleteSessions()` -> wait for server confirmation or `404`, then remove the session and its persisted state
- `moveSessionToDirectory()` -> move the session between directory stores and update the global directory index

### Blocking-request (question/permission) reply routing

`respondToQuestion`, `rejectQuestion`, `respondToPermission`, and `dismissPermission` route the reply through `resolveDirectoryForBlockingRequest`. The directory chosen decides which OpenCode instance resolves the pending request, so it must be the **session record's own server-confirmed directory** (ownership), never the containing child-store key (containment): a project store legitimately holds its worktree sessions, and a reply addressed to the parent instance makes the server answer `QuestionNotFoundError` while the question stays pending in the worktree instance — the session is then stuck on the running question tool with no recovery. When a reply/reject comes back not-found, the stale request is removed locally and a `settled-running-tool` tail materialization is enqueued so the trailing tool part converges to the server's actual state instead of leaving the UI on "asking question" forever.

### Restore (unarchive) contract

The OpenCode server cannot clear `time.archived` over HTTP: `session.update`
only applies the field when the payload carries a finite number, so an omitted
key is a no-op and `null` is silently ignored. Restore therefore writes
`time.archived = 0` (`UNARCHIVED_TIMESTAMP` in `session-actions.ts`). Every
client-side reader classifies archive state by truthiness of `time.archived`,
so `0` reads as active in the UI, the event reducer, and the OpenCode app/TUI.

The server's `time_archived IS NULL` list filter still excludes such rows, so
any query that wants a truthful active list must fetch inclusively
(`archived: true`) and split client-side (`splitGlobalSessionsByArchived`).
The global sessions store does this for its full and per-directory loads;
directory bootstrap keeps using the server filter because live child stores
must not hold archived sessions. A restored session re-enters its live
directory store through the authoritative `session.updated` event the server
publishes for the update; until then it remains fully visible through the
global store (sidebar, switcher) and addressable by ID (message loading).

Archive and delete actions capture the active runtime key when they start and
recheck it before every store reconciliation, so a response
produced by the previous runtime is rejected instead of mutating the current
runtime's live or global session state. Restore follows the same guard: a
stale completion returns `false` without touching any store. A guarded batch
stops at the first observed runtime change: sessions the server already
confirmed remain archived, restored, or deleted and stay in
`archivedIds`/`restoredIds`/`deletedIds`, while every ID not confirmed on the
captured runtime is returned in `failedIds` so existing partial-failure
feedback stays truthful.
Callers whose confirmation can span a runtime switch may pass an
`expectedRuntimeKey` captured earlier; ordinary callers are guarded by default.

Deletion needs this guard more than archiving does. Session IDs are not unique
across runtimes, and a committed deletion does more than hide a row: it evicts
the session from every live store, removes it from the global cache, clears the
current-session pointer, and calls `cleanupPersistedSessionState`, which erases
that session's queued messages, todos, folder membership, inline-comment drafts,
chat draft, and pins. Committing a stale deletion can therefore destroy user
state belonging to an unrelated session on the new runtime.

`cleanupPersistedSessionState` already refuses an identity whose runtime is no
longer active, so `finalizeConfirmedSessionDeletion` must forward the **captured**
runtime key. Passing the live key would make that check compare a value with
itself and always pass. The in-memory live, global, and UI stores it mutates are
not runtime-scoped, so the calling action must reject a stale runtime before
committing rather than relying on that helper alone.

A `404` still means "already deleted" and commits cleanup, but only while the
captured runtime is active. After a runtime change the `404` describes either
the previous runtime or one this session never belonged to, so the action
reports failure instead of committing. The deletion already accepted by the
server stays deleted there; its persisted state is left as harmless stale
metadata and the next authoritative load reconciles it.

## The golden rule

When creating a draft in `handleDirectoryEvent`, **only clone the state fields the event will mutate**. Never spread all fields eagerly.

```typescript
// WRONG — clones everything, breaks referential equality for all subscribers
const draft = {
  ...current,
  session: [...current.session],
  message: { ...current.message },
  part: { ...current.part },
  permission: { ...current.permission },
  // ...
}

// RIGHT — only clone what this event type touches
const draft = { ...current }
switch (event.type) {
  case "message.part.delta":
    draft.part = { ...current.part }
    break
}
```

## Why this matters

Zustand skips re-renders when a selector returns the same reference (`Object.is`). If you spread `session: [...current.session]` but the event only modifies `part`, the `session` array gets a new reference. Every component using `useSessions()` re-renders for nothing.

During streaming, `message.part.delta` fires ~60 times/sec. Eagerly cloning all fields caused every subscriber in the entire app to re-render 60/sec — a 10x overhead. Targeted cloning reduced MessageList renders from ~1972 to ~296 per session.

## Event → field mapping

Keep this in sync with `handleDirectoryEvent` in `sync-context.tsx`:

| Event type | Fields to clone |
|---|---|
| `session.created/updated/deleted` | `session`, `permission`, `todo`, `part`; archived/deleted sessions also clone `question` |
| `session.diff` | `session_diff` |
| `session.status` | `session_status` |
| `todo.updated` | `todo` |
| `message.updated` | `message` |
| `message.removed` | `message`, `part` |
| `message.part.updated/removed/delta` | `part` |
| `vcs.branch.updated` | (none — mutates `draft.vcs` directly) |
| `permission.asked/replied` | `permission` |
| `question.asked/replied/rejected` | `question` |
| `lsp.updated` | `lsp` |

### Directory-less session events

The global stream can omit a directory for a session-addressed event. Resolve it through the session routing index first. If the index is briefly stale during a session transition, route only when the event session matches the active session and that directory store exists; otherwise leave it un-routed rather than updating another directory.

## Adding a new event type

1. Add the case to the event reducer (`event-reducer.ts`)
2. Add a corresponding case to the switch in `handleDirectoryEvent` (`sync-context.tsx`) that clones **only** the fields your reducer writes to
3. If your event fires frequently (more than a few times per second), verify that unrelated components don't re-render — check with the stream perf counters

## Selector hygiene

Select leaf values, not containers:

```typescript
// WRONG — returns entire Map/object, new reference on any mutation
useDirectorySync((s) => s.permission)

// RIGHT — returns the value for one key, stable unless that key changes
useDirectorySync((s) => s.permission[sessionID] ?? EMPTY)
```

Same applies to `useStreamingStore` — select `.get(key)` not the Map itself. Chat live-tail freeze does not use that store; `useSessionStreamingMessageId` reads the Pi reducer instead.

### Topic-scoped subscribe (token-path isolation)

`usePiSessionSnapshot(selector, isEqual?, topic?)` is the Pi store equivalent of a Zustand selector. The cache still keys on store snapshot identity: if `getState()` has not published a new object, the previous selection is returned without re-running the selector. Re-running an allocating selector on an unchanged snapshot makes `useSyncExternalStore` loop and freeze the tab. Equality on the *result* alone (`isEqual`) can skip React paint, but it cannot skip selector execution — and selector execution is what the topic bus eliminates.

`PiSessionStore` publishes one notification per topic touched by a commit:

- `session:{id}` — that session's reducer record changed (messages, parts, lifecycle on the transcript). Token deltas on session B do not wake session A's chat selectors.
- `catalog` — `state.catalog` identity changed (lifecycle, title, membership, stub insert). Token deltas that leave the catalog ref unchanged do not wake catalog subscribers.
- `chrome` — cluster UI: `connection`, `error`, `directory`, `selectedSessionId`, `sessions[]`, `sessionsListStatus`, `focusPending`, `hydratedSessionIds`.
- `*` (default when `subscribe` is called without a topic) — broadcast to every listener regardless of topic. Kept for tests and legacy callers; production hooks pass an explicit topic so the broadcast path is unused on the token hot path.

Hook migration rules:

- Chat transcript hooks (`useSessionMessageRecords`, `useSessionParts` narrow, `useSessionMessageCount`, `useUserMessageHistory`, `useSessionReducerPart`, `useSessionStreamingMessageId`) subscribe on `session:{id}`.
- Sidebar / list hooks (`useCatalogUiSessions`, `useSession`, `useSessionStatus`, `useAllSessionStatuses`, sidebar `hasBusySession` / `catalogLiveKey` / `catalogReady`) subscribe on `catalog`.
- Loader / chrome hooks (`useSessionMessageLoadState`, `useSessionRenderable`, `useSyncDirectory`, sidebar `connection`, `piDirectoryChildStore.subscribe`) subscribe on `chrome`.
- `useSessions` is two subscriptions: `directory` on `chrome`, list on `catalog` (via `useCatalogUiSessions`).
- `useSessionParts` legacy scan (no sessionId known to the caller) subscribes on `*` — that path has no id to narrow on.

Load-state hooks must not be put on `session:{id}` — that would keep ChatContainer waking on every token for loader math. Custom `isEqual` is for derived arrays/records whose contents are unchanged even though the selector allocated a new container (user-message history, load-state tuples). Token deltas are folded by `PiStreamCadence` and flushed once per animation frame, so selector subscribers see at most one store publication per frame unless a boundary event (start/end/lifecycle) flushes immediately.

`applyPiEvent` clones only the mutated session; other `bySession` entries keep their previous references, so a selector that returns one session skips React work for background sessions. `commitEvents` emits `session:{id}` only for the ids touched by accepted events, plus `catalog` iff `nextCatalog !== prevCatalog`. It never emits `chrome` on the token path; chrome flips happen on hydrate, focus, reconnect, lifecycle-list changes, and resets.

## Store splitting pattern

### Why split

A single Zustand store with N properties means every subscriber's selector re-evaluates on every state change — even if the change is unrelated to what that subscriber reads. During streaming, `sessionMemoryState` updates ~60/sec. Before the split, all 68+ `useSessionUIStore` subscribers re-evaluated on each update. After splitting into focused stores, only `useViewportStore` subscribers (2-3 components) re-evaluate.

The optimization multiplies with targeted event cloning: fewer new references per event × fewer subscribers per store = dramatically less work per SSE frame.

### The stores

| Store | Owns | When it changes |
|-------|------|-----------------|
| `session-ui-store.ts` | Session selection, draft lifecycle, abort, worktree, SDK actions | Session switch, draft open/close |
| `voice-store.ts` | Voice connection/activity state | Voice toggle |
| `input-store.ts` | Pending input text, synthetic parts, attached files | User typing, file attach, revert/fork |
| `selection-store.ts` | Per-session model/agent/variant choices | Model/agent picker |
| `viewport-store.ts` | Scroll anchors, session memory state, sync status | Streaming, scroll, session switch |

### Rules for new UI state

1. **Never add to `session-ui-store`** unless it's session selection, draft lifecycle, or abort state
2. **Group by change frequency** — state that changes during streaming (viewport, memory) must not live with state that changes on user action (selections, input)
3. **Skip canonical no-ops** — selecting a session must not republish an already-reset draft; session ID and directory remain the authoritative navigation publication.
4. **Group by subscriber set** — if only 2 components read a value, it should be in a store that only those 2 components subscribe to
5. **Prefer a new store over growing an existing one** if the new state has different subscribers or change frequency
6. **Cross-store reads use `.getState()`** — actions in one store that need to read another store call `useOtherStore.getState()` (imperative, no subscription)

### Anti-patterns

```typescript
// WRONG — stuffing unrelated state into one store
const useEverythingStore = create(() => ({
  voiceMode: "idle",
  scrollAnchor: 0,
  selectedModel: null,
  pendingInput: "",
  // 20 more fields...
}))

// RIGHT — separate stores by concern + change frequency
const useVoiceStore = create(() => ({ voiceMode: "idle" }))
const useViewportStore = create(() => ({ scrollAnchor: 0 }))
const useSelectionStore = create(() => ({ selectedModel: null }))
const useInputStore = create(() => ({ pendingInput: "" }))
```
