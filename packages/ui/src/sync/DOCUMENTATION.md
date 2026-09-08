# Sync architecture, event handling & store update rules

## Scope

This document covers the current client-side session/data architecture in `packages/ui/src/sync` and the rules for updating stores safely.

### One live owner: `PiSessionStore`

- Owned by `PiSessionStore` via `pi-session-context.tsx` and the restored UI-facing sync hooks
- Cluster source for live session/message/part state across the connected runtime: a single event stream, one `reducer.bySession` map, one `hydratedSessionIds` set
- Backs the focused project's sidebar list, the chat timeline, and the in-flight busy/retry panels for every resident session
- Folder focus swaps the sidebar list pointer without touching the cluster; only `clear()` / `dispose()` / runtime switch resets the cluster
- Backed by `/api/pi/*` and the Pi event stream
- Read via hooks like `useSessions()`, `useSessionMessageRecords()`, `getSyncSessions()`

### Global sessions cache (retired)

`packages/ui/src/stores/useGlobalSessionsStore.ts` was deleted. It is not a data scope and must not be reintroduced. Former consumers now read the live catalog directly: retention cleanup via `loadSessionCatalog` + `partitionCleanupCandidates`, mobile restore via `loadSessionCatalog([persistedDirectory])` + `decideMobileRestore`, the mobile widget via a synchronous `catalog.byId` read, and `session-ui-store` via a `catalog.byId` directory lookup.

### Live truth vs transcripts

The two layers are intentionally different, and neither is a copy of the other:

- `PiSessionStore` is **not** a complete global view. It is created lazily per connected runtime and hydrates only sessions the user has visited (subject to the soft eviction cap). It is optimized for live, in-flight session data.
- The **live catalog** (metadata-only: no messages, no parts) is the complete runtime-wide view across known directories, including archived rows and cold directories. The **global live status derivation** for busy/retry comes from the catalog's `lifecycle` mirror.

So:

- Use the **Pi runtime-scoped store** for live session/message state on the connected runtime, including background busy sessions the focused folder does not own
- Use the **Pi live catalog** for cold/global session coverage (archived pages, unopened directories, retention cleanup, mobile restore)
- Retention cleanup, mobile restore, the widget, and `session-ui-store` directory lookup read the catalog directly (see Catalog read paths and Catalog access boundary)

### Runtime-scoped sessions

The Pi cluster belongs to the connected runtime, not the focused project:

- One event stream, one `reducer.bySession`, one `hydratedSessionIds` set, and one runtime generation guard
- Strict Mode remounts, focus changes, and same-runtime reconnects reuse that cluster owner. HMR disposes the shared store before replacement; raising the browser connection limit is not a substitute for one stream.
- `directory` is a focus pointer for the sidebar list, the new-session cwd, and the `selectProject` daemon focus — not a liveness boundary
- An open new-session draft with no materialized session is a blank-chat navigation intent. A resident Pi selection and a stale session URL may continue for background continuity, but neither may replace the draft or be serialized as the visible route.
- A draft worktree intent is a runtime, owning-project, source-directory, and start-ref scoped request to create an isolated checkout before materialization. It is distinct from branch checkout, waits for server `setup-ready`, and requires a matching creation receipt whose returned path becomes the requested draft cwd. Failure preserves the draft and never falls back to the source checkout. The submit that starts background creation keeps its captured draft, prompt payload, model configuration, and receipt through completion under a unique draft task ID; selecting another session cannot redirect that prompt. Pending composer state belongs to that draft ID, so existing sessions and newer drafts remain interactive, including when several worktrees are created from the same source and start ref. The submitted prompt is removed from the generic composer draft slot once the task owns it and is restored on failure only if that same draft remains current. If the captured draft is no longer current, materialization creates and prompts the worktree session without changing the current session or active directory. A draft branch intent is an explicit, runtime-and-directory-scoped request to mutate the draft cwd before materialization. It is held only in runtime memory, clears when project or directory ownership changes, and is never restored from the persisted last-draft target. Materialization rejects a pending intent without a matching checkout receipt. The composer obtains that receipt only after authoritative preflight and confirmed checkout, so cancellation and checkout failure cannot create a session or consume the prompt. The confirmation reads busy/retry lifecycle records from the runtime-wide Pi session catalog on demand and lists active sessions from the selected project and its known worktrees; it rechecks before checkout and requires another click in the same dialog if a new session appeared.
- With no PiChamber project selected, `connectWithoutProject()` probes `/api/pi/runtime` and sets `connection: 'ready'` with a null folder focus. It does not adopt the daemon cwd. Leaving `connection` at `'loading'` is reserved for an in-flight first attach, not for "no folder yet".
- Folder focus (`focusProject(directory, preferredSessionId?)`) replaces the `sessions[]`, sets the `selectedSessionId`, hydrates the new id only when cold, and never disposes the stream, clears `hydratedSessionIds`, drops other folders' hydrated transcripts, or rewrites `connection: 'loading'` for the cluster. The mounted chrome bridge compares normalized path identities before writing focus back to `useDirectoryStore`; slash style, drive-letter case, and trailing separators must not create a feedback update.
- Folder focus sets `focusPending: true` while the list is in flight so the chat can keep its existing view (or its existing PiChamber logo loader) instead of clearing back to `ChatEmptyState`. `sessionsListStatus` distinguishes `'loading'` / `'ready'` / `'failed'` and discriminates authoritative empty success from list failure. A preferred id that `getSession` rejects as `INVALID_SESSION` stays selected, clears `focusPending`, and lands in `sessionLoadErrorById` so the chat shows "Session could not be loaded" instead of spinning on "Untitled Session"
- Same-folder selection is a pointer change on the resident cluster (`select(id)`)
- A failed list for the new folder surfaces an error on that slice only after one automatic retry on transient 5xx / 408 / 429; previous folder sessions, the stream, and other folders' hydrated transcripts all survive
- Warm folder switches skip the loader: if the preferred id is already hydrated, `focusProject` selects it immediately and resolves the list in the background. `start({directory})` also seeds the focus with `lastSelectedSessionForDirectory(directory)` so the chat reopens on the remembered session with no spinner.
- `start({ directory, sessionId })` lists that folder and hydrates the id once. It must not `getSession` first just to learn `directory`; that downloaded the whole transcript twice on a `?session=` deep link. A miss in the listed folder still `getSession`s and re-opens the owning cwd. `getSession` to discover cwd is only for `start({ sessionId })` with no directory
- Idle transcripts are evicted by a deferred microtask scan (soft cap `PI_TRANSCRIPT_EVICTION_SOFT_CAP` = 16) that walks `lastAccessById` in ascending order and never evicts the selected, busy/retry, or pending-prompt session; it keeps the evicted session's `lastSequence`, never runs on the hydrate acquisition path, and is scheduled after both `commitEvents` and `commitHydratedSession` so a render mounting many entries scans once, not once per entry
- `applyPiEvent` only clones the session the event touches; other resident sessions keep their previous references so a background busy turn does not rebuild the visible transcript tree
- `ensureHydrated(id)` hydrates a session if cold without changing `selectedSessionId` or directory focus — chat surfaces that read a child session inside a tool part must use it instead of `select`, so background hydrations never steal the visible chat. Overlapping `select` / `ensureHydrated` hydrates for the same id share one `getSession`. A leftover `SESSION_RUNTIME_CONFLICT` from overlapping daemon opens retries once and fails that chat only; it must not flip the cluster to `connection: 'error'`
- Historical Task cards do not subscribe to or hydrate every child transcript while collapsed. A child session is requested only while that Task is active or its detail is expanded, and final task metadata suppresses the fallback child lookup entirely.
- `prompt()` must not replace a resident transcript with an empty busy stub. Live events only carry the new turn; installing a blank `bySession` row makes prior history disappear. If the row is missing or has no messages, re-hydrate from `getSession` first. The narrow exception is the first prompt immediately after creation: the create response authoritatively established an empty transcript, so that path marks the empty row as trusted and skips a redundant fetch. Selection and renderability checks likewise treat a resident id in `hydratedSessionIds` as authoritative even when its transcript is empty; refetching that fresh row can race the first prompt and overwrite live lifecycle, model, or thinking updates. A hydrated id with no resident reducer row is instead treated as an evicted transcript and restored. Accepted slash prompts also have a bounded snapshot fallback: it runs only if no assistant/lifecycle event has cleared the optimistic pending state, settles from authoritative idle, and takes one final snapshot for non-streaming extension model/thinking/UI mutations. Fetch failure preserves the live optimistic state. A settled session with no transcript renders the composer-first draft surface while retaining its real session identity; an initial extension command does not supply a derived title, so the first later conversation prompt names that same session. Untitled sessions with an authoritatively empty transcript (`messageCount === 0`, threaded through `piSessionToUiSession`) display as "Awaiting first prompt" via `getSessionDisplayTitle`; unknown counts keep the existing untitled fallback and never infer emptiness. `ExtensionNoticeToasts` mounts in that empty-session branch too, so extension `notify` confirmations (for example mode-switch results) toast exactly as they do in an active chat. A live event for a session whose transcript was dropped but whose `lastSequence` cursor remains triggers the same restore and merges the fetched log onto the in-flight turn; a prompt waits for that restore before dispatching
- `routeMessage` commits the captured composer model, then thinking, then prompts. Picker changes do not call `setModel`/`setThinking`. A failed commit throws and does not send, so extensions that derive status from the committed triple see it on that turn rather than the next one. Slash commands and other live session mutations still apply immediately.
- Reconnect merges the snapshot into the existing cluster without disposals, then hydrates any resident session whose `lastSequence` is behind the resumed cursor so a quiet background turn does not lose the disconnect gap. `getSession` while the daemon is still streaming includes the live assistant/tools, `lifecycle: 'busy'`, and extension live state through its returned `lastSequence`; a later `session.snapshot` force-hydrates that session so a missed replay window cannot freeze the chat or lose one-time extension startup state until refresh. Live or sequence-newer resident content overlays a fetch, but a fetched settled transcript whose cursor is at least as new replaces stale overlapping message and part content.

## Ownership map

| Layer / Store | Owns | Scope |
|---|---|---|
| `PiSessionStore` (`apps/pi-session-store.ts`) | Live event stream, reducer `bySession` (LRU-capped transcripts), `hydratedSessionIds`, `lastAccessById`, the live catalog, per-directory refresh generation, delete tombstones, and all session mutations (`create` / `rename` / `archive` / `remove` / `fork` / `navigate` / `compact` / `prompt`) | One runtime-wide cluster |
| `PiSessionStore` transcript paging | Bounded initial hydration, older-page deduplication, stale-result rejection, and prepend reconciliation | One runtime, directory, and session ID |
| `pi-session-catalog.ts` | Live runtime-scoped metadata catalog (`byId`, `byDirectory`, `listStatusByDirectory`); field-sensitive in-flight list reconciliation with delete tombstones; the at-most-2-in-flight directory refresh scheduler | All known directories in the active runtime |
| `pi-session-catalog-cache.ts` | Best-effort runtime-scoped browser snapshot of stable catalog metadata for warm first paint; never persists lifecycle/retry/hydration authority | Up to four recently used runtimes and 2,000 session rows |
| `PiSessionCatalogFeeder` (`pi-session-catalog-feeder.tsx`) | Subscribes to `useProjectsStore` + `useWorktreeStore`; fills the catalog for every known directory (project roots + worktrees), deduped by sorted signature | All known directories; React-mount lifecycle |
| `session-catalog-access.ts` | `loadSessionCatalog(directories?)` completeness-checked read path for retention cleanup and mobile restore | All known directories in the active runtime |
| `session-ordering.ts` | Ephemeral lifecycle rank used by every user-visible session list | All known sessions in the active runtime |
| `session-activity-timing.ts` | Elapsed time of the running turn and of the turn that just finished, plus the persisted starts that survive a reload | All known sessions in the active runtime |
| `notification-store.ts` | Turn-complete and error notifications with viewed/unviewed state; fed by `PiSessionStore` lifecycle events | Active runtime |
| `revert-navigation-store.ts` | UI-owned revert navigation records (`previousLeafId`, abandoned branch, editor text), keyed by `runtimeKey:sessionId` | Active runtime |
| `session-actions.ts` | Canonical entrypoints for SDK-calling session mutations; delegates to `PiSessionStore` methods | App UI state |
| `session-directory-resolution.ts` | Session directory resolution helpers used by `getDirectoryForSession` and diagnostics | App UI state |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, action entrypoints | App UI state |
| `known-session-directories.ts` | The shared `buildKnownSessionDirectories(projects, worktrees)` helper the sidebar and feeder use to agree on the directory set. Dedupe is case-insensitive; returned paths keep filesystem casing for daemon list RPC | App-wide |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `attachment-files.ts` | Attachment picker allowlists, MIME/content validation, structured-text sanitization, and HEIC conversion | Local chat attachments across shared UI runtimes |
| `document-attachments.ts` | Bounded Office/OpenDocument extraction, document text serialization, embedded-image extraction, and positional citations | DOCX, PPTX, XLSX, ODT, ODP, and ODS chat attachments |
| `input-store.ts` | Draft input state, attachment preparation/upload/cleanup, synthetic parts | App UI state |
| `selection-store.ts` | Canonical per-session model/agent/variant preferences; opening an existing chat restores from the hydrated Pi session, not `lastUsedProvider`. Owns the one-time `context-store` migration (canonical wins, legacy fills gaps, `currentAgentContext` is a fallback for missing agent selections only), persists variants, exposes the `hasHydrated` composer gate, and retains entries unbounded with no eviction. The legacy disk key is left as a read-only recovery backup and is never consulted after the migration marker persists. | App UI state |

Local chat attachments are normalized by `attachment-files.ts` before entering `input-store.ts`. PNG, JPEG, GIF, WebP, and PDF retain their media type; HEIC/HEIF is converted to JPEG; recognized text/code formats and unknown files whose first 4 KB are text are sent as `text/plain`; archives and other binary files retain their declared MIME type or use `application/octet-stream`. Jupyter notebooks become readable markdown with non-text outputs omitted. HAR credentials, cookies, and sensitive URL parameters are redacted, while request/response body text is omitted. SVG and Draw.io files are attached as source text, not executable/rendered content. Web, desktop, hosted-mobile, and Capacitor pickers expose the same allowlist, while drag-and-drop may still accept an unknown extension after content inspection.

Office and OpenDocument packages are metadata-validated before asynchronous extraction, with limits of 20 MB compressed input, 5,000 archive entries, 25 MB per entry, 8 MB per XML part, and 100 MB total uncompressed content. Unsafe or non-canonical archive paths reject the whole attachment, and only XML, relationship, and supported image entries are decompressed and retained. Extracted text, including its explicit truncation notice, is bounded to 2,000,000 characters. At most 50 signature-validated PNG, JPEG, GIF, or WebP images and 40 MB of image bytes are retained, with a 20 MB per-image limit; unsupported, invalid, omitted, and truncated content remains explicit in the extracted text. Images whose citations fall beyond text truncation are not attached. Extracted document content remains a `text/plain` file attachment with the original document filename, rather than becoming visible user-message text. Supported embedded images become separate image file parts; the extracted text contains `[filename]` citations at the source paragraph, slide object, spreadsheet cell anchor, or OpenDocument text position. Generated image filenames are re-evaluated if the composer changes during asynchronous preparation, avoiding collisions. The store publishes all generated parts atomically after extraction, creates ephemeral object URLs only for image previews, and uploads the prepared `File` bytes without retaining a base64 copy in the draft.

The composer compares normalized attachment MIME types with the selected model's declared input modalities. It warns when a newly attached file or an existing attachment after a model change requires an unsupported modality, but does not block sending. Missing modality metadata remains unknown and does not produce a warning.

`input-store.ts` owns local attachment preparation and upload. It publishes a card immediately, preserves atomic document-extraction groups, and moves each local file through `preparing`, `uploading`, `ready`, or `failed`. At most three uploads run at once. Progress updates replace only the changed attachment and publish whole-percentage changes. Removal aborts queued or active work, removes every member of a `sourceDocumentId` group, and asks the active runtime to delete an unused ready upload. Runtime changes invalidate every completion from the old runtime and leave local bytes available for Retry.

A normal prompt dispatch accepts only unexpired `ready` attachment IDs and never uploads those files again. Pending or failed attachments are rejected in the send layer as well as the composer controls. Legacy persisted queue entries without lifecycle state may refresh from their retained data URL immediately before dispatch. Queue entries serialize local bytes to a data URL only when queueing so an expired upload can be refreshed; the prompt is not dispatched until refresh succeeds. Prompt failure leaves completed uploads attached for retry. Successful prompt dispatch removes only the composer entries that took part in that send.

Queued auto-send (`useQueuedMessageAutoSend`) dispatches a queued entry only on authoritative live evidence of a terminal lifecycle, never on a transition heuristic. Its tri-state gate (`resolveQueuedAutoSendReadiness`) reads the current runtime's `PiSessionStore` state: `busy`/`retry` hold; `ready` requires `connection === 'ready'`, a catalog row owned by the captured (normalized) directory, and a live-observed terminal (`idle`/`error`) mirror — `record.hydrated`. Everything else is `unknown`, and `unknown` never dispatches: a non-ready connection, a missing row, a colliding session id from another directory, an archived row, and a cold row (the persisted first-paint cache restores every row as `idle` and directory listings carry no lifecycle) cannot invent idle. The dispatcher answers cold rows with an `ensureHydrated` demand — no selection or focus change — whose commit flips `hydrated`, re-emits the catalog, and lets the next scanner pass decide on live state. Demands are deduplicated per target while in flight, verified against authoritative state when they settle (the call resolves even on failure), and retried on the shared bounded backoff instead of stranding the item; that backoff is forgotten once authoritative state arrives or the queue entry is removed, so a later requeue or an evicted-then-revisited session demands again. The demand settles with an explicit scanner wake because a commit can land while the dispatch guard is still held. Missing, colliding, archived, and disconnected targets get no demand at all, so those states hold without looping. A confirmed `INVALID_SESSION` target — the authoritative `getSession` recorded that failure in `sessionLoadErrorById` — also gets no demand: hydration can never succeed, so dispatch holds `unknown`, the queued entry stays for inspection, and no further hydration is attempted until an authoritative recovery clears the recorded error or the user removes the entry. The scanner wakes on the existing `catalog` (lifecycle/list edges) and `chrome` (connection) topics only; token deltas mutate neither, so streaming never wakes it, and it reads one catalog row per queued target without projecting transcripts. Queued send configuration, attachments, runtime key, directory ownership, and current-directory-only scope are re-verified at dispatch time; the queue entry is removed only after its send resolves, so one failed queue never erases unrelated entries.

Composer attachments are scoped to the chat-draft identity (runtime, directory, session) like draft text. `input-store.ts` owns the active attachment-draft key so that identity survives composer remounts during session loading. Switching sessions stashes the outgoing files in memory (bounded, uploads keep running) and restores the incoming session's, so unsent images never leak into another conversation. Empty drafts do not consume the bound. Eviction and session deletion cancel local work and delete unused completed uploads. A send that resolves after a draft switch still clears its own files wherever they are stashed; a reload drops all stashes while persisted text drafts survive.

## Live session catalog

`PiSessionStore` owns the runtime-scoped live catalog of every Pi session the connected runtime has surfaced. Transcripts continue to live in `reducer.bySession` (LRU-capped, soft cap 16, idle-eviction on the deferred microtask). The catalog is metadata-only — no messages, no parts — so it can survive an LRU drop and still render a sidebar row.

### Shape

```text
catalog.byId:                    Map<sessionId, LiveSessionRecord>
catalog.byDirectory:             Map<directory, sessionId[]>     // membership
catalog.listStatusByDirectory:   Map<directory, 'idle'|'loading'|'ready'|'failed'>
```

`LiveSessionRecord` carries `id`, `directory`, `parentId`, `title`, `archived`, `createdAt`, `updatedAt`, optional `preview` / `messageCount`, a `lifecycle` mirror (`'idle' | 'busy' | 'retry' | 'error'`), retry countdown/error metadata while applicable, and a `hydrated` flag (a pointer into `reducer.bySession`, not a copy of it).

### Membership rules

- A successful `listSessions` for directory `D` replaces `byDirectory[D]`; other directories are untouched. Rows for ids that left `D` are removed from `byId` only when no other directory in the catalog still owns the record (a session that has moved A → B must keep its B row when A is re-listed without it).
- A successful list never rejects the whole directory for one mutated row. Each list captures its starting catalog as a baseline (held in that operation's closure, so the baseline lives exactly for the RPC duration) and commits through `applyDirectoryListWithReconciliation`: existing rows use a field-sensitive overlay — only `title`/`archived` actually changed since the baseline are preserved from current, live `lifecycle`/`retry`/`hydrated`/`updatedAt` ride `applyDirectoryListToCatalog`'s normal merge, and all other listing fields (including remote renames/archives) win, so a busy/hydration-only event cannot freeze stale metadata while a true rename/archive newer than the list start survives; newly added rows omitted from the stale listing are re-inserted, rows deleted after the start (including ids already absent locally, tracked as bounded delete tombstones only while a list is in flight) are filtered so a stale listing cannot resurrect them, and a delete before any list started relies on authoritative disappearance rather than retained history; rows that moved out of `D` are filtered from `D` while the owning directory keeps them; omitted mutated rows retain existence (metadata-mutated as newer-than-listing, live-only as proof of existence); unmutated rows — including authoritative disappearance — trust the listing.
- A failed `listSessions` for `D` keeps the prior rows for `D` and flips `listStatusByDirectory[D]` to `'failed'`. Failure is not empty success.
- Pi events update rows in place: `session.lifecycle` flips `lifecycle`. `session.updated` writes `title` without bumping last-prompt recency. A user-message start from another device stamps recency and fills an empty stub title from the prompt text so a remote first send is not stuck as "Untitled Session". Token deltas and lifecycle/snapshot boundaries do **not** bump `updatedAt`. Last-prompt recency is written by `PiSessionStore.prompt()` on this client and by remote user-message starts via `touchRecordUpdatedAt`.
- An event arriving for a session that has not been listed yet (`byId` has no row) inserts a `upsertStubRecord` so the sidebar can render the session as busy. `applyDirectoryListToCatalog` preserves a non-idle existing lifecycle on listed ids, so a stub is never downgraded to idle by a slow list.
- A global/home session (created at literal `~` through the "Don't work in a folder" composer target) has no project owner. Project-focused catalog slices and `createSessionOwnershipIndex` exclude it, so it cannot appear in or drive selection for a registered folder. The sidebar adds these unowned records back only in All sessions and marks them for a neutral themed row shade. Literal `~` and expanded-home catalog membership are merged only while the home directory itself is focused. `global-session-directory.ts` owns this identity check. The `PiSessionCatalogFeeder` includes the home directory in its refresh set so globals are re-fetched after a reload. The composer target is defined in `draftTargetProjects.ts` (`__home__` / "Don't work in a folder") and `session-ui-store` persists it as `selectedProjectId: "__home__"`.

### Cached first paint and authoritative fill

On browser startup, `PiSessionStore` reads `pi-session-catalog-cache.ts` before mounting catalog consumers. The cache stores stable sidebar metadata only. Restored records always use `lifecycle: 'idle'`, `hydrated: false`, and per-directory list status `'idle'`; historical cache data can render a warm sidebar but can never claim current activity or completeness. Missing and malformed runtime snapshots remain distinct from a valid cached empty directory. The cache is keyed by runtime identity, retains at most four recent runtimes and 2,000 rows, coalesces writes for 250 ms, and flushes on runtime switch and browser lifecycle suspension. Storage failure is an accepted loss of this convenience cache because the network fill remains authoritative.

`PiSessionCatalogFeeder` is the only direct caller of `PiSessionStore.refreshAllDirectoryCatalogs` from React. It renders once via `SyncRuntimeEffects` — shared by the full app and mobile through `SyncAppEffects` and by mini-chat directly — unconditionally, so cross-folder fill never depends on the retention/auto-delete preference. It subscribes to both `useProjectsStore` (project roots) and `useWorktreeStore` (authoritatively discovered linked-worktree paths). On every change in the union it:

1. Computes the sorted directory-set signature.
2. Skips the refresh when the signature has not changed (project-list reorders and worktree discovery that yields the same paths must not re-list).
3. Waits until the focused directory is connected and its list/hydration demand has settled, so background directories cannot occupy the interactive request path during a runtime or folder switch.
4. Otherwise calls `PiSessionStore.refreshAllDirectoryCatalogs` only for directories whose catalog status is not already `'ready'`.

`refreshDirectoryCatalog` is the single fill primitive. It captures a per-directory generation, bumps it on every call, and ignores stale completions (a slow RPC returning after a newer refresh has begun, or after a runtime switch, commits nothing). Every list/focus/open commit also captures a catalog baseline at operation start and reconciles through `applyDirectoryListWithReconciliation` (see Membership rules), so true `title`/`archived` mutations newer than the list start survive without rejecting unrelated complete entities, while lifecycle/hydration-only changes take the listing's authoritative metadata. Delete tombstones live only while at least one list is in flight and are cleared when the last list settles; a delete before any list started is not tombstoned and relies on authoritative disappearance rather than retained history; runtime resets clear tombstones. After a successful directory commit the catalog owner raises frozen session-ordering baselines for that directory's active rows (monotonic, live ranks never demoted). Stale async `archive`/`rename`/`fork`/`clone` completions are rejected by runtime-generation/key guards and mutate nothing on the new runtime. The at-most-2-in-flight scheduler is owned by `pi-session-catalog.ts` (`mapDirectoriesWithRefreshSlot` uses `mapWithConcurrency(2)`; the older nested `withDirectoryRefreshSlot` is exported only for direct callers and must not be re-nested — two limiters can deadlock).

### Catalog read paths

Sidebar, header, command palette, archive, and mobile session lists read `catalog.byId` / `catalog.byDirectory` through `useCatalogUiSessions` / `useSession` / `useSessionStatus`. `useSessions()` is the focused directory slice; `getSyncSessions()` is the runtime-wide active catalog.

Retention cleanup (`useSessionAutoCleanup`) reads runtime-wide active rows on the `catalog` topic via `listUiSessionsFromCatalog`, computes newest-5 protection against all known active rows, then mutates only `ready`-directory candidates through the catalog owner with per-action runtime/generation guards. Mobile restore loads `loadSessionCatalog([persistedDirectory])` and selects or clears only on an authoritative `ready` scope. The mobile widget reads `catalog.byId` synchronously. `session-ui-store` falls back to `catalog.byId` directory lookup.

`listUiSessionsFromCatalog` treats an omitted or `undefined` `directory` as runtime-wide. `null` or `''` is an empty focused slice (`useSessions()` when the cluster has no directory). A non-empty string is that directory's membership; only a home-directory focus merges the literal `~` and expanded-home aliases. The React hook always passes `{ archived, directory }`, so `undefined` must not be treated as empty.

The feeder waits while the focused folder's list is still in flight (`connection === 'loading'`, `focusPending`, or `sessionsListStatus` `'loading'`/`'idle'`). Every runtime mounts the feeder via `SyncRuntimeEffects` (full app, mobile, and mini-chat); on-demand `loadSessionCatalog` remains the read path for retention and mobile-restore callers.

### Catalog access boundary (`session-catalog-access.ts`)

`loadSessionCatalog(directories?)` is the lightweight completeness-checked read path used by retention cleanup and mobile restore. It owns no list/store: no derived active/archived arrays, mutation overlays, subscriptions, or persisted cache. With no `directories` it collects project roots plus worktrees via `buildKnownSessionDirectories`, the focused Pi directory, and home candidates (feeder precedent; literal `~` excluded except explicit focused demand). It calls `refreshAllDirectoryCatalogs` only for scopes not already `'ready'` (warm `idle` never complete), then reports the committed `catalog`, `readyDirectories`, `failedDirectories`, `complete` (every requested scope `ready`), and `stale` (runtime key, store identity, or generation changed mid-load; stale forces `complete=false` so consumers do not act). One failed directory keeps its visible rows but never blocks other ready scopes. It never changes folder focus or selection. UI session directory ownership resolves via `lib/chat/sessionDirectory.ts` `resolveGlobalSessionDirectory` (`normalizePath(directory) ?? normalizePath(project.worktree)`).

### Failure handling

Per-directory failures stay scoped to that directory. The catalog's `listStatusByDirectory` carries the signal without leaking into `state.connection` (which is owned by the bootstrap / reconnect path). A failed list does not erase other directories' rows, and because a failed list never reaches the reconciliation commit, mutations that landed while it was in flight are already in state and stay there.

### Runtime switch

`dispose` / `clear` reset the in-memory catalog via `initial()`. `resetForRuntime` flushes the outgoing runtime's pending cache write, clears live state and generations, then seeds the incoming runtime from its own cached snapshot when present. Cached directories remain `'idle'`, so the normal feeder revalidates them. Runtime identities never share catalog rows. The `hydratedSessionIds` set, `lastAccessById`, per-directory refresh generations, and delete tombstones all clear in lockstep (the active-list counter is left for in-flight operations to decrement; their commits are rejected by the generation guards). Stale async `archive`/`rename`/`fork`/`clone` completions from the previous runtime are rejected before they can mutate the new runtime's catalog.

Ctrl+R reload keeps the active runtime and its last session: the active endpoint (`apiBaseUrl` + `runtimeKey`) is persisted to `pichamber:lastRuntimeEndpoint.v1` and re-hydrated before `getRuntimeKey`/`getRuntimeApiBaseUrl` are used, so a reload does not snap back to `local`. The client token is **not** stored in that cache; Electron restores it from the saved host / local-client-token record in `restoreDesktopRelayRuntime` before `SessionAuthGate` checks `/auth/session`. The last active session per runtime is persisted via `last-session-cache` (`oc.lastSession.v1`) on every `setCurrentSession`; `PiSessionProvider` falls back to that persisted session (web/desktop, non-Capacitor) when the in-memory `lastSelectedSessionForDirectory` hint is empty after a reload, and `PiSessionCatalogFeeder` ensures the home directory is part of the catalog refresh so a global `~` session is discoverable.

## Session list rules

### Live cross-directory session/status view

`useGlobalSessionStatus(id)` is a thin alias over `useSessionStatus`: it resolves that session's `lifecycle` mirror from `catalog.byId` on the `catalog` topic. There is no per-directory polling, discovery list, or scan behind it.

Current consumers:

- `SessionSidebar.tsx`
- `SessionNodeItem.tsx` / `useSessionNodeItemMetadata`
- `Header.tsx`
- agent/session activity surfaces using `useGlobalSessionStatus()`

Live busy/retry state must come from the catalog `lifecycle` mirror, which is flipped by accepted lifecycle/snapshot events in `commitEvents` and restored from authoritative listings — never from persisted history or inferred from message timestamps.

`getAllSyncSessions()` returns the runtime-wide active+archived catalog list; `getAllSyncSessionMap()` builds a fresh `Map` from the active catalog on every call — it is not cached or incrementally indexed, so do not use it in render hot paths.

Session display order is last-prompt recency, not last turn stage. `session-ordering.ts` promotes a session only when `observeSessionActivityEvent` sees a new `active` phase (the send path). Settled/idle, hydrate replay, reconnect snapshots, and list `time.updated` stamps do not promote. Pins remain the first ordering bucket. The timestamp/creation fallback is frozen when a session first participates in ordering; creation time and ID provide deterministic ties. Runtime switches clear all phases, baselines, and ranks.

`session-activity-timing.ts` measures how long a turn has been running, because `SessionStatus` carries no timestamps. It is driven from `PiSessionStore` event handling (`observeSessionActivityTiming`, `adoptServerRunTiming`, `removeSessionActivityTiming`), so a row can never count a turn that the catalog calls idle. A session gains a start on its first `active` observation and keeps it across repeated busy/retry events; settling converts that start into a finished duration used by live running rows. Unread completion is a separate `turn-complete` notification in `notification-store.ts`: Pi lifecycle `idle`/`error`/`interrupted` after a live `active` turn appends it for any session that is not currently open, and opening the session marks it viewed.

Sending a prompt promotes that session immediately (`observeSessionActivityEvent('active', reorder)` plus a catalog `updatedAt` bump). Finishing or switching sessions does not reorder. Status dots still follow catalog `lifecycle` (`idle` when the agent is done).

Low-frequency `extension.catalog` events are reduced per session, then coalesced by directory within the ordered event batch. Provider refreshes preserve the previous catalog on failure; resource changes invalidate the skills TTL and fetch immediately only for the focused directory. Command autocomplete observes only the command revision, so a provider-only mutation does not rebuild its list. `session.tree.updated` increments a leaf revision used by an open Timeline dialog; a failed tree reload preserves the last successful labels.

A provider stream that ends without `finish_reason` publishes `session.error` and must complete the in-flight assistant (duration, running tools) so the chat does not stay on "Analyzing". The next send is a new turn even if the UI still tried steer/follow-up.

Starts are persisted so a reload resumes the same count, but a persisted start is a lookup table and never a claim of activity. Active Pi session details and lifecycle/snapshot events may carry the daemon's authoritative `runStartedAt`; first attach adopts that timestamp before the working UI mounts, and later events keep it stable. Pi still emits `busy` at multiple steps of the agent loop, so a busy event without `runStartedAt` means "still running", not "just started"; treating that repeat as a turn boundary resets the counter on nearly every reload. Turn *ends* are marked — `session.idle` and `session.error` fire once, live, and retire the persisted record.

That leaves the case with no observable answer: a turn that ended, and another that began, entirely while the tab was gone. Two bounds stand in for the evidence the client cannot have. A liveness stamp sits beside the start — refreshed while the session is observed active, at most every 15s, and stamped precisely as the page hides (`pagehide`/`visibilitychange`/`freeze`, written immediately rather than through deferred storage so it cannot lose that race) — and is compared against this page's `performance.timeOrigin`, so the measure is how long the app was absent rather than how long bootstrap took; a 20-second startup must not spend the allowance. Records may only be adopted within 90s of load, after which they are discarded — a backstop for a runtime whose event stream is down, where no live event would ever retire the record. A runtime switch resets the module, since the previous instance's turns are not ours.

**Only live events settle a turn.** `session.idle` and `session.error` are the only settle signals; absence from any list or poll is never evidence that a turn ended. Settles act only on turns that already have a live start in this page session (or retire an unclaimed persisted record); only the two bounds above expire a start without a live settle.

Permission handling is server-owned. Pi follows its normal no-permission-popup default. The former permission/question sync hooks, dismissal helpers, and optimistic bridge were removed without replacement; blocking user prompts remain served by Pi extension dialogs. A disconnected client does not invent a reply or claim that a request was resolved.

`usePiSessionSnapshot` caches by store snapshot identity. Selectors that close over a session or message id will keep returning the previous entity when the store has not emitted. Subscribe to the collection (`reducer.bySession`, `sessions`, `hydratedSessionIds`) and look the id up in the hook body.

## Session message loading

`PiSessionStore` is the shared authority for Pi-native session message requests. `getSession` returns a bounded tail page. The mounted timeline calls `loadOlderMessages` when the viewport is underfilled or approaches the top, and the store prepends pages returned by `piClient.getSessionMessages`.

Rules:

1. Request identity includes runtime key, authoritative session directory, session ID, navigation generation, and the opaque before-cursor. Session IDs alone are not globally unique across runtimes or directories.
2. One older-page request is shared by all callers for a session. Scroll and underfill demand cannot fetch the same cursor twice.
3. Fetch failure preserves the resident transcript and cursor. Later demand can retry; failure never becomes authoritative empty history.
4. Runtime switches, navigation, deletion, eviction, and cursor changes reject stale page completions.
5. Page merging deduplicates overlapping anchor messages and lets resident live records win over historical copies.
6. A reconnect `getSession` refresh replaces the bounded tail but preserves older pages already loaded. An older-page response does not advance `lastSequence` because it does not claim coverage of intervening live events.
7. Pagination uses the resident session's server-confirmed directory. It never falls back to the focused directory when the visible session belongs to another worktree.

Initial hydration resolves after the bounded tail is renderable. The timeline fetches older pages only on underfill or near-top demand, preserving the viewport anchor while records are prepended. While that demand remains active, each accepted before-cursor rechecks it so a page hidden inside an existing folded or response-gated turn cannot stall pagination without changing the scroll geometry.

## Loading diagnostics

Session loading instrumentation is disabled by default. Set `localStorage.pichamber_session_load_perf` to `"1"`, reproduce the interaction, then inspect `window.__pichamberSessionLoadPerformance.events`. The in-app Performance overlay (Settings → General → Diagnostics, or `?perf=1`) also enables these events for the current browser only.

The bounded event buffer records only controlled bootstrap, message, and global-list operation/caller labels with queue/duration, outcome, retry count, and downloaded record count where applicable. When diagnostics are enabled, the selected chat records its first painted renderable message snapshot once per recent session identity and immediately clears the corresponding browser performance entry after emitting the trace mark. Canceled frames retain no measured identity, so returning to that session can schedule a replacement measurement; completed identity tracking uses the same 1,000-entry ceiling as the event buffer. Exported events never retain runtime keys, directories, session IDs, credentials, or message content. Initial-message expansion counts every downloaded page, not only the accepted page. The browser profiler independently validates the known labels and finite numeric fields before export. Instrumentation is diagnostic only; unit/type/lint checks do not replace production runtime profiling at representative project/session scale.

High-frequency sync diagnostics are separately disabled by default. Set `localStorage.pichamber_sync_perf` to `"1"` before reload to enable fixed numeric counters for pipeline traffic, reducer publications, streaming reconciliations, entries/messages visited, targeted heartbeat work, and persistence serialization/write volume. The Performance overlay uses the same counters without writing that key. The hot path performs only a boolean check while disabled; counters never retain IDs, payloads, or user content.

Browser profiling also enables `localStorage.pichamber_stream_perf` to capture bounded aggregate timings and render counts for chat projections, message components, and major sidebar boundaries. These metrics contain no session IDs or user content and are reset immediately before each recording. The overlay reads the same aggregates; leave it off during CDP captures so the HUD cannot become the work being measured. See `packages/ui/src/lib/perf/DOCUMENTATION.md`.

The profiler also emits a user-timing mark when pending global-session recency is committed at a lifecycle edge. `summary.json.longTaskAttribution` correlates that mark with enclosing long tasks without recording session data.

## Streaming, live tail & lifecycle

Pi streaming `contentIndex` identifies a content block, not an individual delta. Repeated text or thinking deltas for the same block share an index and append in event-sequence order; sequence rejection, rather than `contentIndex`, owns replay protection.

Streaming assistant text and live tool output are cadence-batched once per animation frame (`PiStreamCadence`) before reaching React. Adjacent cumulative updates for the same tool collapse to the newest snapshot at that frame boundary, while interleaved tools, sessions, and lifecycle boundaries retain order. The live tail overlays those parts onto the streaming message only: when part membership is unchanged (same ids/types, and non-text parts keep reducer identity), `buildLiveStreamingEntry` patches that assistant record and leaves `userMessage`, `activityParts`, and sibling assistants at their previous identities so `ChatMessage` memo can skip them. The live turn's user header and settled sibling assistants also skip when those record identities are unchanged, even if `renderMessage` is recreated for the patched assistant. Neighbor `previousMessage` / `nextMessage` compares use message info, not live part text. A new tool/reasoning part, or a replaced tool object, re-projects the turn. The renderer freezes settled leading markdown blocks and re-lexes only the source tail. While the live tail is still the last block, append-only token updates write that text node directly and skip the async block/HTML pipeline. While the message is still streaming, Shiki and KaTeX stay off for every block, and the unstable live tail is a growing text node in a full-width paragraph (normal wrapping, matching CommonMark `breaks: false`) rather than marked/morphdom HTML. Unfinished code fences, lists, and quotes keep pre-wrap. Highlighting and math land on the settle pass. Live thinking starts collapsed with only its header preview mounted, and stays collapsed when that thinking part settles (the next text or tool part starts) unless the user explicitly expanded it. The block never automatically opens or closes; an explicit user open or closed choice survives streaming-to-settled updates of the mounted block. An expanded live block keeps the bounded max-height plain-text pane that scrolls internally. It does not add a second character-pacing timer, which would multiply parse/morph work while catching up on large streamed chunks.

Event commits are session-scoped, not directory-scoped. `commitEvents` applies accepted events in order to the reducer, clones only the sessions each event touches, mirrors lifecycle/title/recency into the catalog, and emits one notification batch: `session:{id}` per touched session, `catalog` iff the catalog identity changed, and `chrome` for focus/lifecycle-list flips. Token deltas never emit `chrome`. There is no per-directory store transaction layer and no full scan of busy sessions on part-only events.

Chat turn `isWorking` (assistant footer visibility) follows `selectStreamingAssistantMessageId` / reducer `streamingMessages`, not catalog `busy`. A session can remain catalog-busy after the live stream id clears; that must not keep the last-turn footer unmounted. When the runtime connection is `error` or `unavailable`, chat suppresses the retained working and streaming presentation without mutating the transcript cursor; authoritative replay or snapshot state can restore it after reconnect. An explicit `SessionRetry` notice is the narrow exception: it remains working and hides the terminal footer while Pi prepares another attempt. Pi publishes a preparatory `busy` frame before the retried provider produces output, so the reducer preserves the prior `retry` lifecycle and metadata through that frame and through the next `assistant.message.start`; the first accepted text, thinking, or tool event clears retry. An errored `assistant.message.end` stays the active assistant until the following retry or terminal lifecycle frame, preventing a completed footer from flashing between adjacent events. Retry attempt, next-attempt time, and redacted provider text survive the public route, reducer, status hook, reconnect snapshot, and `getSession` hydration. Compaction progress is a separate session-topic leaf: manual, threshold, and overflow compactions carry running/retrying/completed/failed/aborted state through events and hydration. The chat renders the notice on the turn at the compaction timestamp, preserving unrelated turn records and avoiding a broad transcript rebuild on token events.

`useSessionMessageRecords` freezes live-tail text, thinking, and tool-part changes by default: it reads the streaming assistant from `selectStreamingAssistantMessageId` (reducer `streamingMessages`) and reuses the previously published records array. ChatContainer, the composer (`useSessionMessages` / ModelControls), the status row, and the context panel all share that hook, so a token must not re-project the whole transcript in each of them. `useUserMessageHistory` uses the same session topic but treats assistant-part mutations as equal so the composer does not rebuild arrow-history from 200 turns on each token. The streaming tail overlays live parts from `useSessionParts`. A resumed stream may address a hydrated Pi entry through a synthetic live alias; `selectStreamingAssistantMessageId` and `lastMutatedMessageId` resolve that alias to the rendered message's canonical `message.id`, otherwise the frozen record and live-parts overlay target different IDs and a second tab receives events without painting them. A resumed assistant can likewise reference a synthetic user start that predates the second tab's cursor; when that alias is absent, the reducer attaches it to the latest authoritative hydrated user so turn projection does not discard the assistant as an orphan. Pass `suspendPartUpdates: false` only when a caller must see in-flight part bodies in the records array. New messages and historical part edits bust the freeze. Structural Task session identity changes on a non-suspended (historical) message also bust it so a parent can link a newly created subagent immediately. Record publication itself is incremental: `projectSession` plus `piProjectedToRecords` reuse unchanged historical projected messages and record objects, so a token or tool update on the live tail must not remap earlier turns. Freeze prefers `lastMutationKind === 'part'` on the suspended message (O(1)) and only walks historical parts when that signal is missing. `useSessionParts` remaps live parts by reducer-part identity so unchanged tools in the streaming message are not rebuilt on each token.

`useSessionReducerPart` hydrates one reducer part with `mapPart(..., { full: true })` when an expanded tool's render record omitted its body. While expanded it selects that part leaf on `session:{id}` so an unrelated token cannot rebuild the expanded payload. While collapsed it stays off the session topic.

## Session directory resolution

`session-directory-resolution.ts` and `session-ui-store.getDirectoryForSession` own the answer to "which directory does this session belong to". Every send, message fetch, message-queue key, and send-confirmation lookup routes through that answer, so a wrong value is not a display problem: the prompt is posted against a directory that does not own the session, the request is rejected, and the optimistic message is rolled back.

Rules:

1. Ownership comes from the session record's own `directory` (the live catalog row / Pi session record). `getSyncSessionDirectory()` resolves that record directory first — the catalog `byId` row, then the focused directory list's own record — and only falls back to the currently focused directory when neither row is known. That fallback is a guess for a session that is not indexed yet, not its membership or ownership: the function does not report child/containment membership, and its return is not strictly `null` when the session is unknown. Callers must not treat the focused-directory fallback as authoritative ownership.
2. Selection-time directory capture participates in resolution but does not short-circuit it. For a worktree session selected before the catalog indexed it, the selection value is a startup fallback pointing at the parent repository; letting it win would route every send, queue key, and send-confirmation lookup to a directory that does not own the session.
3. Never persist or rank a guessed directory. A guessed selection is neutralized in resolution (`guessedSelectionSessionId` in `session-ui-draft-helpers.ts`) and must not be written to runtime memory or the last-active snapshot — a persisted guess outlives the race that produced it and survives reloads and restarts.
4. Components must not read `currentSessionDirectory` to build request or queue keys; use `getDirectoryForSession()` so every consumer resolves identically. After `getDirectoryForSession` misses, the catalog `byId` row is the direct fallback; a miss there is simply "unknown".
5. `__piDebug.diagnoseSessionDirectory()` reports the routed directory and each contributing source for debugging.

## Session action rules

Session actions live in `session-actions.ts` and delegate to `PiSessionStore`, which is the single mutation authority.

Rules:

1. If an action mutates session list membership or visible session metadata, commit through the owning `PiSessionStore` method (`create`, `rename`, `archive`, `remove`, `fork`, `navigate`, `compact`). There is no separate mirror store to update.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct. `PiSessionStore.resolveSessionDirectory` reads the catalog row first, then the focused list.
3. `session-ui-store.ts` delegates to `session-actions.ts` for these mutations instead of duplicating SDK calls.
4. Every store mutation captures `runtimeGeneration` and `getRuntimeKey()` when it starts and rechecks both before committing, so a response produced by the previous runtime mutates nothing on the current one. This guard lives in the store, not in the action layer.
5. Sending after a revert commits the new branch optimistically: remove the reverted tail and marker before inserting the new message, and restore both if the send is rejected.
6. `session-ui-store.ts` delegates message forks without checking the local catalog and without catching errors or showing toasts. The server is authoritative for session existence. Components await the action and own success or failure presentation, so a rejected fork cannot appear successful.
7. Revert navigation is recorded in `revert-navigation-store.ts` keyed by `runtimeKey:sessionId`: the target entry, the original pre-revert leaf (`previousLeafId`), the abandoned branch previews, and the captured editor text. Restore (`unrevertSession` / `restoreRevertedMessage`) navigates back to that recorded leaf, so a partial restore never replaces the original pre-revert leaf with the currently shortened leaf. A session with no recorded revert rejects restore instead of guessing. Session deletion and runtime switches clear the record for their scope.
8. Composer and queued sends carry their captured runtime, directory, and session through asynchronous preparation. A runtime change cancels the send instead of re-resolving it against the new runtime.
9. After session creation, the directory returned by the server is authoritative over the requested draft directory. The server may canonicalize a worktree path, and the first prompt must use the same directory identity as the created session.
10. A rejected send rolls back its optimistic message; the failure is the user-visible signal. Do not synthesize success or silently retry a send whose outcome is unknown.

### Archive, restore, and delete contract

Archive and restore go through the Pi archive action: `PiSessionStore.archive(sessionId, archived)` calls `piClient.archiveSession` (`POST /api/pi/sessions/{sessionId}/archive` with `{ sessionId, archived }` and the session's directory/runtime scope), then applies `applyArchiveChange` to the catalog after the server confirms. There is no client-side `session.update` timestamp rewriting; readers classify archive state from the session record (`timeArchived > 0`, else the boolean `archived`), so an active row is one without an archived timestamp.

Deletion goes through `PiSessionStore.remove(sessionId)`, which calls `piClient.deleteSession` (`ignoreMissing` treats a `404` as already-deleted success), rejects stale-runtime completions, and then: records a delete tombstone if any directory list is in flight so a stale listing cannot resurrect the row; removes the session from the reducer, catalog, `hydratedSessionIds`, ordering, activity timing, revert navigation, and navigation/history request state; and re-selects the next active session when the deleted one was current.

Persisted per-session state (queued messages, folder membership, chat drafts, pins, stashed attachments) is cleaned by `cleanupPersistedSessionState` (`session-deletion-cleanup.ts`), which refuses an identity whose runtime key is no longer active. It is driven by the authoritative baseline cleanup hook (`useAuthoritativeSessionCleanup`): the hook establishes its first authoritative runtime-scoped baseline without deleting anything, and on a later complete authoritative snapshot removes persisted state only for sessions present in the previous baseline and absent from the current one — never from startup-empty or partially loaded scopes.

## The golden rule

When an event handler builds the next state, **only clone the fields the event will mutate**. Never spread all fields eagerly.

```typescript
// WRONG — clones everything, breaks referential equality for all subscribers
const draft = {
  ...current,
  messages: new Map(current.messages),
  parts: { ...current.parts },
  // ...
}

// RIGHT — only clone what this event type touches
case "assistant.message.delta":
  session = { ...session, parts: session.parts.fork() }
  break
```

## Why this matters

Zustand skips re-renders when a selector returns the same reference (`Object.is`). If you clone every container for an event that only touches one part, every subscriber of the untouched fields re-renders for nothing.

During streaming, `assistant.message.delta` fires up to ~60 times/sec. Eagerly cloning all fields caused every subscriber in the entire app to re-render 60/sec — a 10x overhead. Targeted cloning reduced MessageList renders from ~1972 to ~296 per session.

The same rule applies to `applyPiEvent` in `lib/pi/event-reducer.ts`: it clones only the session and only the sub-fields each event type mutates, so background sessions keep their previous references and `commitEvents` emits `session:{id}` only for the ids touched by accepted events.

## Adding a new event type

1. Add the case to the event reducer (`lib/pi/event-reducer.ts`), cloning only what your reducer writes to
2. Verify the event does not need a `chrome` emission on the hot path — `commitEvents` computes topics from what actually changed
3. If your event fires frequently (more than a few times per second), verify that unrelated components don't re-render — check with the stream perf counters

## Selector hygiene

Select leaf values, not containers:

```typescript
// WRONG — returns entire Map/object, new reference on any mutation
usePiSessionSnapshot((s) => s.catalog.byId)

// RIGHT — returns the value for one key, stable unless that key changes
usePiSessionSnapshot((s) => s.catalog.byId.get(sessionID) ?? null, undefined, sessionID ? `session:${sessionID}` : 'catalog')
```

### Topic-scoped subscribe (token-path isolation)

`usePiSessionSnapshot(selector, isEqual?, topic?)` is the Pi store equivalent of a Zustand selector. The cache still keys on store snapshot identity: if `getState()` has not published a new object, the previous selection is returned without re-running the selector. Re-running an allocating selector on an unchanged snapshot makes `useSyncExternalStore` loop and freeze the tab. Equality on the *result* alone (`isEqual`) can skip React paint, but it cannot skip selector execution — and selector execution is what the topic bus eliminates.

`PiSessionStore` publishes one notification per topic touched by a commit:

- `session:{id}` — that session's reducer record changed (messages, parts, lifecycle on the transcript). Token deltas on session B do not wake session A's chat selectors.
- `catalog` — `state.catalog` identity changed (lifecycle, title, membership, stub insert). Token deltas that leave the catalog ref unchanged do not wake catalog subscribers.
- `chrome` — cluster UI: `connection`, `error`, `directory`, `selectedSessionId`, `sessions[]`, `sessionsListStatus`, `focusPending`, `hydratedSessionIds`.
- `*` (default when `subscribe` is called without a topic) — broadcast to every listener regardless of topic. Kept for tests and legacy callers; production hooks pass an explicit topic so the broadcast path is unused on the token hot path.

Hook migration rules:

- Chat transcript hooks (`useSessionMessageRecords`, `useSessionParts` narrow, `useSessionMessageCount`, `useUserMessageHistory`, `useSessionReducerPart`, `useSessionStreamingMessageId`) subscribe on `session:{id}`.
- Sidebar / list hooks (`useCatalogUiSessions`, `useSession`, `useSessionStatus`, sidebar `hasBusySession` / `catalogLiveKey` / `catalogReady`) subscribe on `catalog`.
- Loader / chrome hooks (`useSessionMessageLoadState`, `useSessionRenderable`, `useSyncDirectory`, sidebar `connection`) subscribe on `chrome`.
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
  scrollAnchor: 0,
  selectedModel: null,
  pendingInput: "",
  // 20 more fields...
}))

// RIGHT — separate stores by concern + change frequency
const useViewportStore = create(() => ({ scrollAnchor: 0 }))
const useSelectionStore = create(() => ({ selectedModel: null }))
const useInputStore = create(() => ({ pendingInput: "" }))
```
