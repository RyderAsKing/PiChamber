# Pi extension API coverage in PiChamber

Date: 2026-08-24

## Sources and scope

This audit compares current upstream `earendil-works/pi` at commit `dcd461925db2edf69a43c8135db1180d418afd54`, PiChamber's pinned `@earendil-works/pi-coding-agent@0.84.1`, and PiChamber's daemon/public/UI extension bridge.

Primary sources:

- upstream [`types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts);
- upstream [`agent-session.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts);
- upstream [`extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md);
- upstream [`rpc.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md);
- pinned declarations and implementation under `node_modules/.bun/node_modules/@earendil-works/pi-coding-agent/dist/core`;
- `packages/web/server/lib/pi/session-daemon/session-daemon.js`;
- `packages/web/server/lib/pi/session-daemon/extension-bridge.js`;
- `packages/web/server/lib/pi/routes.js`;
- `packages/ui/src/lib/pi`, `packages/ui/src/apps/pi-session-store.ts`, and extension UI components.

Current upstream and the pinned package expose the same `ExtensionAPI` method set.

## Result

PiChamber runs extensions inside the real Pi `AgentSession`. Prompt/context/provider/tool hooks execute in the daemon where Pi owns the model and tool loop. The browser receives bounded public events only for state it must display or refresh.

The audit found six compatibility gaps. This work closes all six:

1. `pi.setSessionName()` now maps Pi's `session_info_changed` event to `session.updated`, updating every client's catalog/header.
2. `ctx.reload()` now calls the owning `AgentSession.reload()`, clears stale extension UI state, and invalidates provider/resource/command catalogs.
3. `pi.registerProvider()` and `pi.unregisterProvider()` now publish provider-catalog invalidations. The UI refetches authoritatively without clearing the prior catalog on failure.
4. `pi.setLabel()` now invalidates session-tree consumers; tree responses preserve bounded `label` and `labelTimestamp` fields, and Timeline displays labels.
5. `ctx.shutdown()` now disposes only the requesting idle session runtime after its command or turn settles. It does not stop the shared daemon or unrelated sessions.
6. Standard RPC `ctx.ui.setEditorText()`, `pasteToEditor()`, and `setTitle()` now work. Editor events apply once to the owning visible session and are never replayed from reconnect snapshots. Titles are session-scoped and flow through the existing web/native window-title owner.

The earlier model/lifecycle work also covers `pi.setModel()`, `pi.setThinkingLevel()`, and extension commands that finish without starting an agent turn.

## ExtensionAPI inventory

| API | PiChamber behavior |
|---|---|
| `pi.on(...)` | All Pi hooks execute inside the daemon. Downstream user-visible agent events are projected. |
| `registerTool()` | Static and dynamic tools work. Generic tool start/update/end events render custom executions. |
| `registerCommand()` | Commands run through Pi's RPC prompt path. Name, description, source, and scope appear in autocomplete. Pi argument-completion callbacks remain daemon/TUI-local. |
| `registerShortcut()` | TUI-only in practice because browser clients have no Pi terminal shortcut dispatcher. |
| `registerFlag()` / `getFlag()` | Extension defaults work; PiChamber does not expose extension-specific CLI flag overrides. |
| `registerMessageRenderer()` | TUI-only. PiChamber uses bounded extension cards and declarative `pichamber.ui`. |
| `registerMarkdownTransformer()` | TUI render hook; not executed in the browser markdown renderer. |
| `registerEntryRenderer()` | TUI-only; browser fallback cards remain authoritative. |
| `sendMessage()` | Works, including `steer`, `followUp`, and `nextTurn`. Displayed custom messages become `extension.message`. |
| `sendUserMessage()` | Works and produces ordinary lifecycle/message events. |
| `appendEntry()` | Persists and publishes `extension.entry`; `pichamber.ui` and `pichamber.app` get richer handling. |
| `setSessionName()` / `getSessionName()` | Works and updates clients live through `session.updated`. |
| `setLabel()` | Persists, invalidates open tree consumers, and appears in tree/Timeline output. |
| `exec()` | Works server-side under the daemon user. It is intentionally not a browser shell RPC. |
| `getActiveTools()` / `getAllTools()` | Work inside the daemon. |
| `setActiveTools()` | Works for later model requests. PiChamber has no competing browser-owned active-tool source. |
| `getCommands()` | Works inside Pi; browser autocomplete consumes the bounded extension-list projection. |
| `setModel()` | Works and publishes authoritative `session.model`. |
| `getThinkingLevel()` / `setThinkingLevel()` | Work; writes publish authoritative `session.thinking`. |
| `registerProvider()` / `unregisterProvider()` | Work immediately and invalidate the owning directory's browser catalog. Native provider functions and credentials never cross the wire. |
| `pi.events` | Works inside the extension runtime and remains daemon-local by design. |

## ExtensionContext and command context

| Capability | PiChamber behavior |
|---|---|
| `ctx.mode` / `ctx.hasUI` | `"rpc"` and `true`. |
| `cwd`, `sessionManager`, `modelRegistry`, `model`, `scopedModels`, `thinkingLevel` | Real Pi values inside the daemon. |
| `isIdle()`, `isProjectTrusted()`, `signal`, `abort()`, `hasPendingMessages()` | Real Pi lifecycle/policy values. |
| `getContextUsage()`, `compact()`, `getSystemPrompt()`, `getSystemPromptOptions()` | Work inside Pi; compaction outcomes are projected. |
| `shutdown()` | Session-local deferred disposal. Shared daemon remains available. |
| `waitForIdle()` | Bridged. |
| `newSession()`, `fork()`, `navigateTree()`, `switchSession()` | Bridged to the owning runtime. Pi's `withSession` callbacks pass through. |
| `reload()` | Bridged to `AgentSession.reload()` with UI/catalog reconciliation. |
| replacement-context `sendMessage()` / `sendUserMessage()` | Work in the replacement session. |

## Extension UI

Fully bridged:

- `select()`;
- `confirm()`;
- `input()`;
- `editor()`;
- `notify()`;
- `setStatus()`;
- `setWidget()` with `string[]` content;
- `setEditorText()`;
- `pasteToEditor()` using Pi RPC replacement semantics;
- `setTitle()`;
- PiChamber's additional `form()` dialog.

Dialogs use `extension.dialog` and authoritative `extension.dialog.dismiss` events. Statuses, string widgets, dialogs, panels, apps, and session titles participate in reconnect snapshots where replay is safe. Editor text does not participate in snapshots because replay could overwrite a newer local draft.

Expected Pi RPC/TUI degradation remains unchanged:

- `custom()` returns `undefined`;
- `setWorkingMessage()`, `setWorkingIndicator()`, `setFooter()`, `setHeader()`, `setEditorComponent()`, and `setToolsExpanded()` are no-ops;
- `getEditorText()` returns `""`;
- `getToolsExpanded()` returns `false`;
- theme enumeration/switching is unavailable;
- terminal input, autocomplete wrapping, and rich widget component factories require a TUI component tree.

Extensions should gate terminal-only paths with `ctx.mode === "tui"`.

## Hooks that stay daemon-local

Pi exposes 33 `pi.on(...)` hooks. These hooks modify authoritative execution and should not become browser callbacks:

- `project_trust` and `resources_discover`;
- `context`;
- `before_provider_request`, `before_provider_headers`, `after_provider_response`;
- `before_agent_start`;
- `tool_call` and `tool_result`;
- `input`;
- session-before-switch/fork/compact/tree hooks.

The real `ExtensionRunner` invokes them. Publishing their inputs would leak prompts, headers, provider payloads, or policy details and create a second source of truth.

PiChamber projects downstream rendering/lifecycle state instead: agent start/end/settled, retries, messages and deltas, tool execution, compaction, queues, model/thinking, session names, custom entries/messages, extension UI, catalog invalidations, and tree invalidations.

## Invariants added by the implementation

- Provider and resource invalidations are low frequency and coalesced by directory within an ordered client batch.
- Provider refresh failure preserves the previous catalog.
- Resource refresh runs immediately only for the focused directory; background changes invalidate the cache for the next focus.
- Command autocomplete subscribes only to command revisions.
- Editor events carry session identity and sequence. A background event cannot overwrite the visible composer.
- Reconnect snapshots may restore extension titles but never editor text.
- Label refresh failure preserves the last successful label map.
- Extension shutdown cannot terminate the daemon or another session.
- Every new public event is validated and bounded again at the HTTP/SSE projection boundary.

## Regression coverage

The real-SDK extension E2E test now exercises:

- a blocking dialog and authoritative command completion;
- custom entries/messages;
- extension-authored session rename;
- editor and title events;
- provider catalog invalidation;
- label persistence and tree projection;
- `ctx.reload()` catalog reconciliation;
- session-local `ctx.shutdown()` while daemon health remains ready.

Focused daemon tests cover mutation observers and runtime disposal. Route tests cover new public payload bounds. Reducer tests cover sequence-gated editor/title/catalog/tree state and title snapshot replacement.
