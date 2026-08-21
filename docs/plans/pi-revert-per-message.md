# Plan: Per-message Revert workflow (user + assistant)

Source: `docs/research/pi-revert-support.md` (pinned to pi `f4585b8`) — this plan turns the research's "smallest sound v1" into a **visible per-message action under every message** (user *and* assistant).

## 1. Goal

Add one obvious action **"Revert conversation to here"** under each rendered message (both user and assistant/tool entries) that:

- calls the existing `POST /api/pi/sessions/:id/navigate` / `sessions.navigate` path (no new verb)
- moves Pi's active leaf correctly (user msg → parent, other entry → itself — Pi's `navigateTree` already does this)
- hydrates the shorter active branch
- restores `editorText` into the composer *only if composer is empty*
- shows the abandoned branch in the dock (and later tree UI) without ID `</>` comparison
- is disabled while that session is streaming, and states that files on disk are unchanged

Non-goals (v1): file restore/checkpoints, branch summaries/LLM, `createBranchedSession` fork, touching legacy `session.revert.messageID` contract except to replace it.

## 2. Current state (from research)

- **Backend exists and works:** `session-daemon.js:1913` → `activeRuntime.session.navigateTree(messageId)` → `routes.js:901` → `client.ts:334 navigateSession` → `pi-session-store.ts:1123 navigate()` → `session-actions.ts:92 revertToMessage()`.
- **IDs line up:** daemon projection uses `entry.id` as message id (`:633-710`) and `entryId` in tree (`:1571-1592`). No lookup needed.
- **Broken/incomplete UI:**
  - `navigateTree` returns `editorText`, but `projectActiveSession/projectSessionDetail/PiSessionDetailResponse` drop it — composer never receives it.
  - No per-message button calls `revertToMessage()`; only hidden `/undo` does.
  - `RevertedMessageDock` renders only if `session.revert.messageID` (`revertedMessageDockState.ts:37-70`) which Pi path never sets; and it finds reverted rows by `id < revertMessageID` / `id > revertMessageID` — invalid for 8-char hex Pi IDs.
  - `unrevertSession()` is a no-op (`session-actions.ts:96`), so redo can't work.
  - After hydrate, abandoned tail disappears (active branch only); needs separate state or `GET /tree`.

## 3. Desired UX

### 3.1 Placement — "under each message"

- **Location:** message footer action row — same row that currently shows `Copy` / timestamp (see `MessageBody.tsx` `UserMessageBody.actionsBlock` and `AssistantMessageActionButtons`).
  - Add a new `MessageRevertAction` button to that row, **visible on hover (desktop) and always-visible on touch/mobile** — match `alwaysShowMessageActions = isMobile || isTablet` and `group-hover/message` pattern in `ChatMessage.tsx` / `MessageBody.tsx`.
  - Keep a single row: `Copy | Revert | timestamp`. User messages: right-aligned `flex justify-end`; assistant: left-aligned footer. Reuse `INLINE_MESSAGE_ACTIONS_CLASS_NAME` (`mt-2 mb-1 flex items-center ...`) and `Button variant="ghost" size="icon"` + `Tooltip`.

- **Applies to both roles:**
  - *User message:* tooltip "Revert conversation to here — edit & resend". Navigates to `parentId` (Pi does it), puts original user text in composer.
  - *Assistant/tool message:* tooltip "Revert conversation to here". Navigates to that entry itself (Pi's non-user path), composer stays as-is (no `editorText`). Label could be same or "Revert to this point" — pick one string for v1.

### 3.2 States

- Disabled while `session.isStreaming` / `lifecycle === 'busy'` (Pi rejects streaming nav anyway — `agent-session.ts#3031`).
- Loading spinner (`loader-4 animate-spin`) while navigating (reuse dock's pattern).
- After success: toast `Reverted — files on disk were not changed` (research: must say conversation-only). Abandoned tail appears in `RevertedMessageDock` (collapsed by default).
- First user message → empty transcript until next send — render `ChatEmptyState` / empty list, not an error/loading spinner.
- Fetch failure → toast error, transcript + dock unchanged (never show empty as success).

### 3.3 Strings (locale-ui-patterns)

- Button `aria-label`: `Revert conversation to here`
- Tooltip: `Revert to this point`
- Toast success: `Reverted — conversation rewound. Files on disk were not changed. Edit the prompt and send to continue.`
- Dock title stays `Reverted messages N`
- All strings through i18n keys, not hard-coded English in component.

### 3.4 A11y / Theme

- `aria-label`, `TooltipContent`, keyboard focusable, `focus-visible:ring`.
- Use `theme-system` tokens: `text-muted-foreground hover:text-foreground`, `bg-transparent`.
- Icon: `history` / `arrow-go-back` / `restart` — pick one from `Icon` set, consistent with undo.

## 4. Architecture

### 4.1 Keep existing server verb

Do **not** add `sessions.revert` / `/revert`. Extend the navigate response with whitelisted metadata only:

```ts
// packages/ui/src/lib/pi/protocol.ts
interface PiSessionNavigateResponse extends PiSessionDetailResponse {
  navigation: {
    targetEntryId: string;
    previousLeafId: string | null;
    newLeafId: string | null;
    editorText?: string;
  };
}
```

Daemon (`session-daemon.js:sessions.navigate` handler):
```js
const previousLeafId = activeRuntime.session.sessionManager?.getLeafId?.() ?? null;
const result = await activeRuntime.session.navigateTree(messageId);
// result = { editorText?, cancelled? } per agent-session.ts#L3020
if (result.cancelled) throw ...
const newLeafId = activeRuntime.session.sessionManager?.getLeafId?.() ?? null;
writeFrame(..., {
  ...projectActiveSession(activeRuntime, cwd),
  navigation: { targetEntryId: messageId, previousLeafId, newLeafId, ...(result.editorText ? { editorText: result.editorText } : {}) }
});
```
- Capture `previousLeafId` *before* call, `newLeafId` *after*.
- Whitelist only those 4 fields; don't leak daemon internals.
- Existing guards stay: `INVALID_ARGUMENT` if missing, `SESSION_TREE_NOT_FOUND` on cancel, streaming reject maps to busy error.
- Optionally return `403/409` with `code: 'SESSION_BUSY'` for streaming case (already mapped).

Route (`routes.js:901`): `res.json({ ...projectSessionDetail(result), navigation: result.navigation })` — keep `projectSessionDetail` for session fields, attach navigation.

Client (`client.ts:334`): `navigateSession()` returns `PiSessionNavigateResponse`; keep `getSessionTree()` as-is.

### 4.2 UI-owned navigation state (replaces `session.revert.messageID`)

Create small store: `packages/ui/src/sync/revert-store.ts` or `packages/ui/src/stores/revert-navigation-store.ts` — **not** in `session` row. Key by `(runtimeKey, directory, sessionId)`.

```ts
type RevertNavigationState = {
  targetEntryId: string;
  previousLeafId: string | null;
  newLeafId: string | null;
  editorText?: string;
  abandonedBranch: Array<{ id: string; textPreview: string }>; // ordered by transcript order
  createdAt: number;
}
Map<string /* sessionKey */, RevertNavigationState>
```

Capture abandoned branch **before hydrate**:
1. Snapshot active branch messages `getSyncMessages(sessionId)` or `GET /tree` traversal ordered by `timestamp` + parent links.
2. After navigate, hydrate returns shorter branch. Abandoned = `oldBranch.slice(newBranchLength)` by position (or `parentId` walk), **never** `id < >`.
3. Store `abandonedBranch` for dock. On tree fetch, dock could read tree directly — v1 store is sufficient.

Composer restore:
- If `navigation.editorText` exists and `inputStore.message.trim() === ""` → `setMessage(editorText)` and focus composer. Otherwise leave user draft untouched (research invariant).
- Also reconcile mentions? Pi only returns text — v1 text only. Log TODO for attachments ownership check.

Clear/reconcile when:
- user sends (`prompt`/`steer`/`followUp`) on new branch
- authoritative tree/session shows leaf ≠ `newLeafId` (reconcile, clear stale)
- `runtimeKey` or `directory` switches (`session-ui-store.prepareForRuntimeSwitch`)
- session deleted
- redo completes (navigate to `previousLeafId`)
- `hydratedSessionIds` reset / disposal before next send (Pi reopens at file tail — detect via `lastSequence` mismatch)

Fetch failure invariant (sync-state-invariants): leave last known transcript + revert state intact; don't render empty as success.

### 4.3 Redo

Replace `unrevertSession()` no-op. `handleSlashRedo` and dock "Restore" should:

- If `revertState.previousLeafId` exists → `navigate(previousLeafId)` (not `revertToMessage` with marker math).
- Else no-op.
- After send on new branch, clear `previousLeafId` (redo no longer valid; old branch reachable via `GET /tree` only).

Dock "Restore" / "Fork" rows switch from `id > revertMessageID` search to index lookup in `abandonedBranch`.

## 5. File-level plan

### Phase 0 — Docs & contracts (no runtime change)

- [ ] Add this plan file + update `packages/web/server/lib/pi/session-daemon/DOCUMENTATION.md` and `packages/ui/src/sync/DOCUMENTATION.md` with new `navigation` field.

### Phase 1 — Backend contract (thin bridge)

- [ ] `packages/ui/src/lib/pi/protocol.ts` — add `PiSessionNavigateResponse` with `navigation` object; export `PiNavigationMeta`.
- [ ] `packages/web/server/lib/pi/session-daemon/session-daemon.js` — `sessions.navigate` handler: capture `previousLeafId`, call `navigateTree`, capture `newLeafId`, return `{...projectActiveSession(...), navigation:{...}}`. Handle `cancelled` already there.
- [ ] `packages/web/server/lib/pi/routes.js` — forward `navigation` whitelisted; ensure `projectSessionDetail` not stripped. Add type for response.
- [ ] `packages/ui/src/lib/pi/client.ts` — `navigateSession` return type → `PiSessionNavigateResponse`; keep scope & `assertRuntimeUnchanged`.
- Tests: daemon unit: first msg → `newLeafId:null` + `editorText`; streaming → busy error; missing → preserves branch; projection doesn't leak private fields.

### Phase 2 — Store / state

- [ ] New: `packages/ui/src/sync/revert-navigation-store.ts` (or `packages/ui/src/stores/revertNavigationStore.ts`) — zustand Map by `runtimeKey:directory:sessionId`, actions `setRevertState`, `clearRevertState`, `clearForRuntime/directory/session`.
- [ ] `packages/ui/src/apps/pi-session-store.ts` — `navigate()` now returns `detail.navigation`; expose it; `hydrate()` stays. Ensure failures don't clear reducer (`reverted` error path already there `:1186`).
- [ ] `packages/ui/src/sync/session-actions.ts` — `revertToMessage()` returns `navigation`; `unrevertSession()` → navigate to saved `previousLeafId` (or keep as alias, not no-op). Add `redoRevert(sessionId)` helper.
- [ ] `packages/ui/src/sync/session-ui-store.ts` — `revertToMessage` / `handleSlashUndo/Redo` rewired to navigation meta + revert-navigation-store; call `useInputStore.setMessage` for empty-composer restore; push/clear redo stack via store not `session.revert`.
- [ ] Wire clearing hooks: `prepareForRuntimeSwitch`, `remove()` / `session-deletion-cleanup.ts`, `setActiveSession`, prompt send success.
- [ ] `packages/ui/src/components/chat/revertedMessageDockState.ts` — rewrite `buildRevertedMessageDockState` to consume `revert-navigation-store` (or tree order), remove `< >` on IDs, use array position + `parentId` links. Keep `EMPTY_REVERTED_MESSAGE_DOCK_STATE` shape or add new selector.
- Tests: ordering by position not ID; empty composer restored vs preserved; runtime/directory switch clears; fetch failure preserves; redo navigates to `previousLeafId`.

### Phase 3 — UI: per-message action under each message

#### 3a. New component

- [ ] New: `packages/ui/src/components/chat/message/MessageRevertAction.tsx`

```tsx
type Props = { sessionId: string; messageId: string; role: 'user'|'assistant'; disabled?: boolean }
export const MessageRevertAction: React.FC<Props> = ({ sessionId, messageId }) => {
  const isStreaming = useIsSessionStreaming(sessionId); // from sync-refs / pi-session-store
  const navigate = useSessionUIStore(s => s.revertToMessage);
  const [busy, setBusy] = useState(false);
  // onClick: await navigate(sessionId, messageId); toast...
}
```

- Styling: `Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground"` + `Tooltip` "Revert to here". Icon `history` or `refresh` from `Icon`.
- `disabled={busy || isStreaming}`, `aria-busy`, spinner while busy.
- Confirmation? Research Q1: v1 **no modal**, but toast must mention files not restored. Add `confirm` prop for later.

#### 3b. Injection points

- [ ] `packages/ui/src/components/chat/message/MessageBody.tsx`
  - `UserMessageBody` : extend `actionsBlock` — currently `Copy + timestamp`. Add `<MessageRevertAction>` before timestamp, inside `group/user-actions` flex. Prop `sessionId, messageId` through.
  - `AssistantMessageBody` : extend `AssistantMessageActionButtons` — add revert button beside copy/share (currently 2 icons). Pass `sessionId/messageId` in.
  - Keep `MessageFilesDisplay`, `TurnChangedFilesDropdown` untouched.

- [ ] `packages/ui/src/components/chat/ChatMessage.tsx`
  - Thread `sessionId`/`message.id`/`role` into `MessageBody` calls (3 call sites: `UserMessageBody` x2 + `AssistantMessageBody`). Currently `ChatMessage` has `message.info.id`, `message.info.sessionID`, `isUser` — plumb them.
  - Alternatively, have `MessageBody` read `messageId` from own props — but `MessageRevertAction` needs session id; pass explicitly to avoid extra store reads per row.
  - Ensure `ChatMessageMemo` comparison (`renderCompare.ts`) includes new prop or is shallow-safe.

- [ ] `packages/ui/src/components/chat/components/TurnItem.tsx`
  - No change needed if `ChatMessage` handles it; just verifies `turn.userMessage` + `assistantMessages` both render reverts.

- [ ] `packages/ui/src/components/chat/composer/ui/RevertedMessageDock.tsx`
  - Switch source from `session.revert.messageID` to new revert store selector. Map `abandonedBranch` to `items` (preview via `getRevertedPreview` still valid). Keep collapsed logic, restore/fork handlers but route restore → `navigate(previousLeafId)` / fork → `forkFromMessage`.

- [ ] `packages/ui/src/components/chat/ChatContainer.tsx` or `MessageList.tsx`
  - No list change; just ensure `RevertedMessageDock` sits above composer (already does in `ChatContainer`).

### Phase 4 — Polish, a11y, perf

- [ ] `theme-system`: ensure hover/visible states match `MessageBody`'s `group-hover/message` pattern; test light/dark + mobile.
- [ ] `locale-ui-patterns`: move all strings to keys, add `aria-label="Revert conversation to here"`.
- [ ] `performance-engineering`: `MessageRevertAction` is per-message (could be 200+ rows). Keep it light: `React.memo`, no new `useDirectorySync` per row — read `isStreaming` via single `usePiSessionStreaming(sessionId)` hook subscribed once. Avoid creating new closures per render (use `useCallback` with stable `sessionId/messageId`).
- [ ] Touch: `isMobileSurfaceRuntime()` already used for overscan — reuse for always-show actions.

## 6. Data flow (v1)

```
User clicks Revert under msg X
  -> MessageRevertAction: set busy, call sessionUIStore.revertToMessage(sessionId, X.id)
    -> session-actions.revertToMessage -> piSessionStore.navigate -> client.navigateSession
      -> POST /api/pi/sessions/:id/navigate {messageId:X.id}
        -> session-daemon: previousLeafId=getLeafId(); result=navigateTree(X.id); newLeafId=getLeafId()
        -> response: {session, messages /*active branch*/, navigation:{target, previousLeafId, newLeafId, editorText}}
    -> hydrate(sessionId, detail)  // replaces transcript with active branch
    -> revert-navigation-store.set({target, previousLeafId, newLeafId, editorText, abandoned=old.slice(newLen)})
    -> if editorText && composer empty -> inputStore.setMessage(editorText) + focus
    -> toast success
    -> RevertedMessageDock reads abandoned[] and renders
```

## 7. Validation checklist

**Backend tests**
- [ ] navigate to user entry moves to parent + returns editorText
- [ ] first user entry → `newLeafId:null`, empty transcript, not error
- [ ] streaming → busy error, no branch change
- [ ] missing/cancelled → preserves branch, no `navigation` leak
- [ ] projection whitelists only navigation fields
- [ ] reopen after bare nav selects file tail; send after nav persists new branch (research invariant)

**Store tests**
- [ ] messageId sent unchanged as entryId
- [ ] hydrate replaces active branch, dock gets abandoned tail by order
- [ ] failed nav preserves transcript+dock
- [ ] composer restored only when empty
- [ ] runtime/directory switch clears scoped state
- [ ] redo navigates to `previousLeafId`; send clears redo

**UI tests**
- [ ] action appears under every user *and* assistant message
- [ ] disabled while streaming
- [ ] click triggers navigate, toast says files not changed
- [ ] first-msg revert renders empty, not failed fetch
- [ ] dock uses order, not lexical ID
- [ ] a11y: keyboard, aria-label, tooltip
- [ ] perf: no extra re-renders on streaming patches (`turnProjectionCache` stable)

Existing suites to run:
- `bun run test -- packages/ui/src/components/chat/revertedMessageDockState.test.ts`
- `bun run test -- packages/ui/src/sync/session-actions.test.ts`
- `bun run test -- packages/ui/src/apps/pi-session-store.test.ts` (if exists)
- `bun run type-check` (workspace-wide after protocol change)
- `bun run dead-code` (if exports change)

## 8. Rollout order

1. Phase 1 backend (behind type flag, no UI yet) — mergeable, verifies daemon `editorText` propagation.
2. Phase 2 store — behind feature flag `revertNavigationStore` if desired.
3. Phase 3 UI per-message action — small PR touching only `MessageBody` + new `MessageRevertAction` + `ChatMessage` props.
4. Phase 3b dock rewrite — separate commit to avoid mixing message row + dock logic.

Each phase keeps `RuntimeAPIs` and fetch/URL handling via existing `runtimeFetch`/`scope()` paths (`ui-api-decoupling`).

## 9. Product decisions to lock before coding

1. Confirm label/tooltip copy + "files not changed" toast (Q1 research).
2. Scope v1 to user+assistant vs only user — this plan does both; if assistant revert feels ambiguous, gate assistant rows behind `enableAssistantRevert=false` flag (one boolean).
3. Decide attach­ment-restore: v1 text only (Pi returns text only) — document as known limitation.
4. Confirm no confirmation modal v1 (fast revert, undo via redo).
5. Confirm ephemeral redo (browser reload clears — daemon leaf in-memory until next append).

## 10. Risks & mitigations

- **Per-message button clutter:** keep icon-only ghost, hover-reveal on desktop, always-show on touch; truncates to `Copy · Revert · time`.
- **Performance on large sessions:** memoize action, single streaming subscription per session, not per message.
- **Durability:** document that bare nav is transient until next send; reconcile on `lastSequence` drift after daemon restart.
- **ID comparison bug:** explicitly remove `< >` on IDs; use `parentId` chain + array index.
- **Composer clobber:** never overwrite non-empty composer (research guard).
