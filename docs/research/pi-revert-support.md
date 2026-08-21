# Pi revert support research

**Reviewed:** 2026-08-21  
**Upstream commit:** [`f4585b8bec581d005cbb1edfc07edfcce723d0ae`](https://github.com/earendil-works/pi/commit/f4585b8bec581d005cbb1edfc07edfcce723d0ae)  
**Scope:** Pi's conversation revert behavior and the smallest useful PiChamber implementation before a tree UI.

## Bottom line

Pi does not have a separate `revert` operation. Its TUI implements this behavior with `AgentSession.navigateTree()`. Selecting a user message moves the active leaf to that message's parent and returns the selected prompt as `editorText`. The user can edit and send it again. Selecting another entry type makes that entry the active leaf. Existing entries remain in the session tree, and the next append creates a new branch.

This changes conversation context only. It does not restore files changed by tools.

PiChamber already has most of the backend path:

- private daemon commands for `sessions.tree` and `sessions.navigate`
- public `GET /api/pi/sessions/:id/tree` and `POST /api/pi/sessions/:id/navigate`
- typed client methods for both routes
- `PiSessionStore.navigate()` and a `revertToMessage()` action

The current feature is incomplete in the shared UI. `/undo` can call navigation, but there is no per-message action. Pi's returned `editorText` is discarded. The inherited reverted-message dock and redo logic depend on `session.revert.messageID`, which the Pi path never sets. They also compare random Pi entry IDs as if those IDs encode chronology.

The smallest sound first version should reuse the existing navigate route instead of adding another server verb. It should add explicit UI-owned revert state, preserve the abandoned branch by entry order rather than ID comparison, and return the selected user text to the composer.

## Verified upstream behavior

All upstream links below are pinned to `f4585b8bec581d005cbb1edfc07edfcce723d0ae`.

### Session tree and active branch

Pi stores session entries as an append-only JSONL tree. Each entry has an `id` and `parentId`. `SessionManager` keeps an in-memory `leafId`; appending an entry makes it a child of that leaf and advances the leaf ([`session-manager.ts#L845-L866`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts#L845-L866), [`#L1044-L1066`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts#L1044-L1066)).

`getBranch()` follows parent links from a selected entry or the current leaf. `buildSessionContext()` resolves the active, compaction-aware context sent to the model ([`session-manager.ts#L1260-L1285`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts#L1260-L1285)). `getTree()` retains all branches and sorts siblings by timestamp ([`#L1305-L1347`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts#L1305-L1347)).

`branch(entryId)` only changes `leafId`. `resetLeaf()` moves before the first entry. Neither method deletes or rewrites entries ([`session-manager.ts#L1354-L1374`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts#L1354-L1374)).

A bare navigation is therefore transient until another entry is appended. When Pi reopens a file, `_buildIndex()` sets the leaf to the last entry in file order ([`session-manager.ts#L958-L976`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts#L958-L976)). If the runtime is disposed after navigation but before the user sends, reopening the session selects the old file tail again.

### What `navigateTree()` does

`AgentSession.navigateTree(targetId, options)` is the relevant public operation ([`agent-session.ts#L3020-L3223`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/agent-session.ts#L3020-L3223)).

For a normal user message, it:

1. chooses the message's `parentId` as the new leaf
2. returns the message text as `editorText`
3. calls `branch(parentId)` or `resetLeaf()` for the first message
4. rebuilds `agent.state.messages` from the selected branch

The user-message handling is at [`agent-session.ts#L3138-L3149`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/agent-session.ts#L3138-L3149), and the leaf move plus context rebuild is at [`#L3166-L3184`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/agent-session.ts#L3166-L3184). For non-user entries, the selected entry itself becomes the new leaf.

The TUI clears and rerenders the transcript after navigation, then puts `editorText` into an empty composer ([`interactive-mode.ts#L5169-L5300`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5169-L5300)). It does not send automatically.

### Branch summaries and events

Navigation may summarize the abandoned path. `branchWithSummary()` appends a `branch_summary` entry under the destination and records the abandoned leaf in `fromId` ([`session-manager.ts#L1376-L1405`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts#L1376-L1405)). A minimal revert does not need this option or an LLM call.

Extensions receive `session_before_tree` before mutation and may cancel or supply summary data. Pi emits `session_tree` after the leaf move and context rebuild ([`extensions/types.ts#L640-L670`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/extensions/types.ts#L640-L670), [`agent-session.ts#L3085-L3097`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/agent-session.ts#L3085-L3097), [`#L3205-L3213`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/agent-session.ts#L3205-L3213)).

Pi rejects navigation while the agent is streaming. A missing entry throws. Selecting the current leaf is a no-op. Extension cancellation returns `{ cancelled: true }` ([`agent-session.ts#L3031-L3055`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/agent-session.ts#L3031-L3055), [`#L3093-L3095`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/agent-session.ts#L3093-L3095)).

### No file restoration

`navigateTree()`, `branch()`, and `resetLeaf()` do not call file tools or restore workspace contents. Pi's branch summarizer can describe file operations, but it does not undo them. Revert must be described as conversation-only unless PiChamber adds a separate checkpoint mechanism.

### Tree navigation is not file forking

Pi's `/tree` remains in the same JSONL file. `createBranchedSession()` creates a new session file from one root-to-leaf path ([`session-manager.ts#L1408-L1510`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts#L1408-L1510)). PiChamber should keep conversation revert and session fork as separate product actions.

## Verified PiChamber state

### The transport already works

The private daemon's `sessions.navigate` handler calls `activeRuntime.session.navigateTree(messageId)` and then returns a fresh projected session (`packages/web/server/lib/pi/session-daemon/session-daemon.js:1913`). The public route forwards `POST /api/pi/sessions/:sessionId/navigate` to that command (`packages/web/server/lib/pi/routes.js:901`).

The shared client exposes `navigateSession()` (`packages/ui/src/lib/pi/client.ts:334`). `PiSessionStore.navigate()` calls it and hydrates the returned session detail (`packages/ui/src/apps/pi-session-store.ts:1123`). `revertToMessage()` already delegates to this method (`packages/ui/src/sync/session-actions.ts:92`).

The tree read path also exists, ending at `PiSessionStore.tree()` (`packages/ui/src/apps/pi-session-store.ts:1202`). No current component consumes it.

### IDs already line up

Daemon transcript projection uses each Pi message entry's `entry.id` as the browser message ID (`packages/web/server/lib/pi/session-daemon/session-daemon.js:633-710`). Tree projection exposes the same value as `entryId` (`packages/web/server/lib/pi/session-daemon/session-daemon.js:1571-1592`). No message-to-entry lookup layer is needed.

Pi's IDs are generated opaque 8-character hex values. They do not encode time. Existing UI code in `session-ui-store.ts` and `revertedMessageDockState.ts` uses `<` and `>` comparisons on IDs to find earlier or later messages. That cannot represent tree or transcript order reliably.

### Why users do not have a usable revert feature

There are several disconnected pieces:

- No per-message revert button calls `revertToMessage()`.
- `/undo` is registered, but it is not an obvious message action.
- `navigateTree()` returns `editorText`, but `projectActiveSession()`, `projectSessionDetail()`, and `PiSessionDetailResponse` omit it. The composer cannot restore the selected prompt.
- `RevertedMessageDock` returns no UI unless `session.revert.messageID` exists (`packages/ui/src/components/chat/revertedMessageDockState.ts:37-70`). The Pi navigation and hydration paths never set that marker.
- `unrevertSession()` is a no-op (`packages/ui/src/sync/session-actions.ts:96`). The current `/redo` path therefore cannot restore the former active leaf.
- The dock expects reverted messages to remain in the ordinary message store. A post-navigation hydrate contains only the newly active branch, so the abandoned tail needs separate UI state or a tree fetch.

This is partly a leftover contract from the pre-Pi sync model. The backend primitive is present, but the UI state model was not adapted to Pi's tree.

## Recommended revert-first implementation

### 1. Keep the existing server operation

Do not add `sessions.revert` or `/revert` just to alias navigation. The current route already calls Pi with the correct user entry ID. Calling `navigateTree()` with the parent instead would duplicate Pi's target logic and lose its `editorText` behavior.

Extend the navigation response with optional metadata instead:

```ts
interface PiSessionNavigateResponse extends PiSessionDetailResponse {
  navigation: {
    targetEntryId: string;
    previousLeafId: string | null;
    newLeafId: string | null;
    editorText?: string;
  };
}
```

The daemon should capture the old leaf, preserve `navigateTree()`'s result, and return only whitelisted fields. The route and client should type that response. The server must still enforce Pi's streaming guard.

Returning `previousLeafId` gives the client a stable redo target while the runtime remains active. It does not make a bare navigation durable across daemon disposal.

### 2. Add a small UI-owned navigation state

Store navigation state by runtime, directory, and session. At minimum it needs:

- selected target entry ID
- previous leaf ID for redo
- ordered abandoned user entries for the dock
- composer text returned by Pi

Capture the pre-navigation active branch from the transcript or `GET /tree` before hydrating the shorter branch. Use array position and parent links. Never compare entry IDs for ordering.

Clear or reconcile this temporary state when:

- the user sends on the new branch
- authoritative tree/session data shows a different leaf
- runtime or directory changes
- the session is deleted
- redo completes

A fetch failure must leave the last known transcript and navigation state intact. It must not look like a successful empty branch.

### 3. Add one visible action

Start with a per-user-message action named "Revert conversation to here". Disable it while that session is streaming. On success:

- hydrate the returned active branch
- put `editorText` in the composer if the composer is empty
- show the abandoned user messages in the existing dock after replacing its marker contract
- state plainly that files on disk were not changed

The first user message is a required test case. Its new leaf is `null`, and the active transcript becomes empty until the user sends again.

### 4. Treat redo as tree navigation

Redo should navigate to the saved former leaf, not call the current no-op `unrevertSession()`. If the process restarts before a new append, Pi reopens at the file tail, which may already look like a full redo. The client must reconcile against the authoritative active branch instead of blindly replaying a stale marker.

A full tree UI can later replace the temporary abandoned-branch list. The API does not need to change for that step.

## Focused tests

Backend tests:

- navigating to a user entry moves to its parent and returns `editorText`
- navigating to the first user entry returns `newLeafId: null`
- streaming navigation maps to the existing busy error
- missing and cancelled targets preserve the current branch
- the public projection returns navigation metadata without daemon-private fields
- reopening after bare navigation selects the last persisted file entry, while sending after navigation persists the new branch

Shared client and store tests:

- message IDs are sent unchanged as tree entry IDs
- navigation hydrates the returned active branch
- a failed navigation preserves the existing transcript and dock state
- composer text is restored only when the composer is empty
- runtime and directory switches clear scoped temporary navigation state

UI tests:

- the action appears only on eligible user messages and is disabled while streaming
- first-message revert renders an empty active transcript without treating it as a failed fetch
- the dock uses branch order, not lexical ID order
- redo navigates to the saved former leaf
- sending after revert clears temporary redo state and leaves the old branch discoverable through the tree API

## Product decisions still needed

1. Should clicking the action require confirmation? The copy must say that workspace files remain untouched.
2. Should attachments from the selected prompt return to the composer? Pi only returns text. Reattaching uploads may need a separate safe ownership check.
3. Should temporary redo survive a browser reload? The daemon leaf is in memory only until another entry is appended, so browser persistence alone cannot make this reliable.
4. Should v1 expose only user-message revert, or allow assistant and tool entry navigation? User-only matches the edit-and-resend interaction and avoids ambiguous composer behavior.
5. When should branch summarization appear? It adds cost, cancellation, model availability, and extension behavior. It should wait for the tree UI.

## Sources

Upstream Pi, pinned to `f4585b8bec581d005cbb1edfc07edfcce723d0ae`:

- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/session-manager.ts)
- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/agent-session.ts)
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/compaction/branch-summarization.ts)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/core/extensions/types.ts)
- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [`packages/coding-agent/docs/session-format.md`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/docs/session-format.md)
- [`packages/coding-agent/docs/sessions.md`](https://github.com/earendil-works/pi/blob/f4585b8bec581d005cbb1edfc07edfcce723d0ae/packages/coding-agent/docs/sessions.md)

PiChamber sources:

- `packages/web/server/lib/pi/session-daemon/session-daemon.js`
- `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md`
- `packages/web/server/lib/pi/routes.js`
- `packages/ui/src/lib/pi/protocol.ts`
- `packages/ui/src/lib/pi/client.ts`
- `packages/ui/src/apps/pi-session-store.ts`
- `packages/ui/src/sync/session-actions.ts`
- `packages/ui/src/sync/session-ui-store.ts`
- `packages/ui/src/sync/DOCUMENTATION.md`
- `packages/ui/src/components/chat/revertedMessageDockState.ts`
- `packages/ui/src/components/chat/composer/ui/RevertedMessageDock.tsx`

No file restoration or dedicated `revert` verb was found in the pinned upstream session implementation. No code or runtime behavior was changed during this research.
