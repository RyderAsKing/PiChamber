# Mobile project sync diagnosis and fix plan

## Reported behavior

Two browsers connect to the same PiChamber server on a VPS. Mobile adds a project and starts a session there. The already-open desktop browser sees the session, but not the project. It groups the session under another known project until the user adds the missing project on desktop.

## Root cause

Project membership and session activity use different synchronization paths.

- Projects live in the server-owned UI settings document at `/api/pi/ui-settings`.
- `useProjectsStore.addProject()` updates the current browser immediately, then calls `updateDesktopSettings({ projects, activeProjectId })`.
- The server atomically writes the settings patch and returns the new document only to the browser that made the request.
- Other connected browsers receive no settings event. They call `syncDesktopSettings()` only at startup or after switching runtimes, so an already-open desktop keeps its old project list indefinitely.
- Pi sessions use the runtime event stream. The desktop therefore receives the phone-created session even though its project registry is stale.
- `createSessionOwnershipIndex()` assigns a session to the deepest registered ancestor of the session directory. With the new project absent, an older parent project, including a broad root or home project, can claim it. That explains why the session appears under an apparently unrelated project. If no registered ancestor exists, the session has no project bucket.
- Adding the project manually on desktop updates that browser's project registry. The ownership index recomputes and places the already-known session under the correct project, matching the reported recovery.

There is a second correctness problem in the same contract. Project changes send the whole `projects` array as one shallow settings patch. A stale desktop can later rename, reorder, add, or remove a project and overwrite a newer array written by mobile. Adding a notification alone would narrow this race but would not make concurrent project mutations safe.

## Evidence

The current route contract has only GET and PUT handlers. The PUT writes and returns settings but publishes nothing to other clients:

- `packages/web/server/lib/pi/routes.js`
- `packages/web/server/lib/pi/ui-settings-store.js`

Client synchronization is startup/runtime-switch driven, while successful writes dispatch `pichamber:settings-synced` only in the writing window:

- `packages/ui/src/lib/persistence.ts`
- `packages/ui/src/App.tsx`
- `packages/ui/src/apps/MobileApp.tsx`
- `packages/ui/src/stores/useProjectsStore.ts`

Session ownership deliberately walks parent directories until it finds a registered owner:

- `packages/ui/src/components/session/sidebar/sessionOwnership.ts`

Focused checks run during diagnosis:

```text
bun test packages/web/server/lib/pi/routes.test.js -t "serves PiChamber UI settings"
1 pass

bun test packages/ui/src/components/session/sidebar/sessionOwnership.test.ts
5 pass
```

The route test confirms request/response persistence. The ownership tests confirm deepest-known-project assignment. There is currently no cross-client settings test, which is the missing regression seam the fix needs to add.

## Implementation status

The cross-device propagation fix is now implemented on this branch. The server publishes revision-only invalidations through the authenticated `/api/pi/ui-settings/events` SSE endpoint. Direct browser, relay, and native Capacitor clients use their established runtime transport and authentication paths. Clients fetch the authoritative settings snapshot when the revision changes, probe the small revision endpoint every 10 seconds while visible as missed-event recovery, and refresh immediately after focus, foreground, or network resume. An unchanged probe does not parse or apply the settings document. Project synchronization preserves a still-valid local active project, preventing the phone's folder selection from moving the desktop workspace.

Conflict-safe project mutation operations remain follow-up work. The notification stream closes the reported stale-client display bug, but simultaneous stale project-array writes still need server-side project operations or revision preconditions.

## Fix plan

### 1. Add a server-owned settings revision

Extend the UI settings store so every successful mutation advances a monotonic revision under the store's existing serialized write queue. Return the revision with reads and writes without placing project paths or other settings values in notification messages.

The revision must be based on mutation order, not wall-clock time. A server restart must load or reconstruct it without allowing an older client write to look current.

### 2. Publish settings invalidations to all connected clients

Add an authenticated PiChamber settings-change stream owned by the web runtime. A successful settings write publishes only the new revision. Do not duplicate the settings document in events because it contains filesystem paths and other private preferences.

Use the shared runtime transport helpers so hosted mobile, Capacitor mobile, browser desktop, Electron, and relay connections follow an explicit supported path. The implementation should reuse an existing general server event channel if one already owns non-daemon server events. Otherwise add a narrow `/api/pi/ui-settings/events` SSE endpoint before the generic proxy and cover disconnect cleanup and reconnect behavior.

On notification, clients fetch the authoritative document, generation-check it against the current runtime, then call the existing settings application path. Coalesce repeated revisions and ignore revisions already applied. A fetch failure preserves current projects and retries with bounded backoff. It must not apply an empty project list as a failure fallback.

### 3. Make project mutations conflict-safe

Do not keep replacing the complete project array from stale browser state without a precondition.

Preferred approach:

- Add focused project mutation operations at the server-owned settings boundary: add, remove, rename/update metadata, reorder, and select active project.
- Execute each operation inside the UI settings store's serialized mutation queue against the latest document.
- Return the complete authoritative settings snapshot and revision.
- Make add idempotent by normalized project path/id. Define remove of an already-removed project as a successful no-op. Validate reorder against current IDs instead of accepting a stale replacement array.

If the existing generic PUT must remain for other settings, add revision preconditions to whole-document collection fields and reject stale project-array writes with `409`. The client should refetch and replay the user's project operation once against the new snapshot. It must not blindly retry the stale array.

### 4. Reconcile browser state without disrupting active work

When an authoritative project snapshot arrives from another device:

- Update `useProjectsStore` and its runtime-scoped local mirror.
- Preserve the current chat/session if its session still exists.
- Recompute known session directories so `PiSessionCatalogFeeder` fetches the newly registered directory.
- Let `createSessionOwnershipIndex()` naturally move the existing session from the stale ancestor bucket to the exact project.
- If the remote active project changes, do not automatically steal focus in another browser. Active project selection should be device-local, or the contract must split shared project registration from per-client navigation state. The current shared `activeProjectId` risks one device navigating another and should not be propagated as a remote navigation command.
- A remote project removal must define what happens when that project is active locally. Keep the open session usable, remove the sidebar project registration, and choose a fallback only when the user next navigates, unless product behavior explicitly requires immediate navigation.

### 5. Add regression coverage before changing behavior

Add a two-client integration test that models the reported sequence:

1. Desktop loads settings containing project A.
2. Mobile adds project B.
3. Desktop receives an invalidation and reloads without a page refresh.
4. A session event for project B is grouped under B, not A.

Also cover:

- mobile and desktop add different projects concurrently; both survive;
- stale rename/reorder cannot erase a remote addition;
- duplicate add is idempotent;
- notification before GET completion and several coalesced notifications;
- disconnect, reconnect, and missed-event catch-up by revision;
- settings fetch failure preserves the previous project list and retries;
- runtime switch rejects a late notification or fetch from the old VPS;
- relay and direct authenticated transports;
- project removal while another client has that project/session open;
- broad ancestor projects such as `/` cannot retain a session after its exact project arrives.

The tight regression command should be a focused server/client integration test and should fail on today's code because desktop never receives project B.

## Validation for the implementation

Run the focused UI settings store, route/transport, persistence, project store, catalog feeder, and session ownership tests. Because this changes a shared server/client contract and realtime transport, also run workspace type-check and lint, the web build, relay transport tests, and the affected mobile/Electron integration checks. Run `bun run dead-code` if the change adds files or exports.

Manual validation should use two independent browser profiles connected to one VPS. Keep desktop open, add a folder and start a session on mobile, and confirm desktop adds the project and moves the live session into it without refresh or focus theft. Repeat with both clients adding different projects at nearly the same time.
