# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- `MessageBody.tsx` owns message-level orchestration only. User subtask/shell rendering lives in `../UserAuxiliaryParts.tsx` with pure classification in `../userAuxiliaryPartsModel.ts`; assistant copy/fork/revert/save-image controls live in `../AssistantMessageActionButtons.tsx`.
- Turn activity is projected once by `components/TurnActivityRail.tsx`, which keeps reasoning, progress text, and tools in one chronological disclosure rail across all assistant records.
- Tool rendering has two presentation layers inside that rail:
  - **Static tools** -> `StaticToolRow.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `StaticToolRow.tsx`
  - Owns compact static-tool presentation, short-description derivation, and file/skill navigation.
  - Reuses the same tool-row typography constants as `ToolPart`.
  - If you want to change how `read` or classified skill rows look in compact mode, edit here.

- `ToolPart.tsx`
  - Orchestrates expandable tool rows (bash/edit/write/question/task + fallback).
  - Owns row lifecycle, task/session projection, header composition, timer state, editor navigation, and Git refresh side effects.
  - Keeps the entrypoint below the monolith threshold; expanded body rendering lives in `ToolExpandedContent.tsx`.

- `ToolExpandedContent.tsx`
  - Owns expanded tool input/output rendering, JSON views, diffs, diagnostics, attachments, and streaming bash output.
  - Rich diff rendering remains lazy so the `@pierre/diffs` + Shiki stack stays out of the eager chat graph.

- `useDeferredExpandedContent.ts`
  - Owns staggered post-click body mounting while preserving synchronous first-mount measurement for default-open/virtualized rows.

- `taskToolModel.ts`
  - Owns Task metadata parsing and child-session summary projection.
  - `part.state.metadata.sessionId` is the only live identity contract between a Task and its child session.
  - A running Task may briefly have no `sessionId`; render it as waiting until the authoritative part update arrives. Never match parallel children by order, title, timestamp, or status.
  - Part-level metadata and output parsing exist only for older persisted records and never override state metadata.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `StaticToolRow.tsx` and `ToolPart.tsx`.

- `toolRenderUtils.ts`
  - Owns core tool classification plus pure display derivation shared by the expandable row/body: normalized names, display paths/descriptions, diff/write stats, write previews, question parsing, and diagnostic normalization.
  - If a tool should switch between static vs expandable, change its classification here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `../useTurnToolsState.ts`
  - Owns tool disclosure state for the turn-level rail while preserving the per-message expansion caches.

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

- Assistant markdown treats raw HTML as inert visible text. The final generated
  HTML is sanitized as defense in depth, with script and style elements
  forbidden, so message content cannot inject active DOM or application-wide
  CSS into any runtime surface.
- `read` and the legacy explicit `skill` tool are **static navigation tools** and render via `StaticToolRow`. Pi loads skills through `read`; when the daemon attaches authoritative `metadata.pichamber.skill`, that read renders as a one-line Skill row and opens the discovered skill in Settings instead of opening `SKILL.md` as a file.
- Every other tool, including search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`.
- Tool rows are not grouped under count labels. Each activity keeps its stable part identity, individual disclosure state, metadata, duration, output, and lifecycle in the turn-level rail.
- The managed `pichamber` plugin tool uses the expandable path and hides its broad protocol input. The plugin supplies the selected action's human description as the native tool title; the UI renders that metadata without owning an action map. The full versioned result envelope renders through the same neutral JSON summary/tree/raw views as other tools, without a tool-specific output card.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render. Settled historical tools whose output or patch exceeds the render-record budget arrive as `state.deferredBody` stubs; expanding hydrates the canonical reducer part through `useSessionReducerPart` instead of keeping full bodies in every transcript record. Task child transcripts are requested only while the Task is active or expanded; a settled collapsed Task uses its persisted metadata/output and does no child-session work.
- The message list folds settled history turns older than the most recent two behind a centered **Load older history** control. That control reveals the two turns immediately above the visible window; **Load all history** restores every folded turn. Neither action changes the session log. A settled turn with more than 32 assistant records carrying final response content initially mounts the response header and its newest 31 records. Activity-only records (tools, reasoning, and progress text projected to the activity rail) never mount in the response block or trigger its gate, so tool-heavy turns avoid both null message rows and a response pill. **Load earlier response** reveals 32 more final-response records and **Load full response** mounts the rest. Active streaming turns remain complete so incoming tool and text records never land behind the gate. Tool bodies stay deferred until expanded. During a stream, token updates patch only the live assistant record when part membership is unchanged; sibling messages and turn activity keep their previous identities so they do not rebuild with the growing text.
- Closed timeline and context surfaces do not subscribe to the active transcript. Inactive context-panel diff tabs are unmounted; only the visible diff owns session-derived work.
- The rich tool diff preview lives in `ToolPartDiffPreview.tsx` and is lazy-loaded from `ToolPart`. It is the only tool-card piece that imports the `@pierre/diffs` + Shiki rendering stack, keeping that stack out of the eager chat startup graph. While its chunk loads (first rendered diff only) the plain-text patch from `PlainDiffFallback.tsx` renders as the Suspense fallback, mirroring the preview's error fallback. `ToolPart` itself must not statically import `@pierre/diffs` runtime modules or `@/lib/shiki/appThemeRegistry`.
- Running bash output falls back to `state.metadata.output` until canonical `state.output` arrives. Live output keeps at most 16 lines in the DOM (DeepSeek's terminal card cap) inside a compact viewport; it follows new output until the user scrolls up, then resumes following when the user returns to the bottom. Live output appends or replaces rewritten snapshots as plain text without worker highlighting; finalized output normalizes ANSI terminal controls with a bounded synthetic-cell budget, bypasses the throttle, and receives the normal one-time highlighted rendering.
- Thinking blocks show duration when timing is available (`ReasoningPart.tsx`).
- The last assistant message in a settled turn renders a footer in `MessageBody.tsx` (model name, optional thinking variant, duration, timestamp). It stays hidden while that assistant is in the live reducer `streamingMessages` set or while an explicit `SessionRetry` notice represents the active retry. Catalog or generic session `busy` after the stream ends must not keep the last-turn footer unmounted; older turns already skipped that heuristic because they are not the latest turn. Its entry animation runs only when the same mounted message transitions from working to settled. Historical mounts, session switches, and earlier footers exposed by a new send remain static.
- Each assistant turn keeps a one-line working header immediately below its user prompt. The live latest turn reads its active message directly from the reducer `streamingMessages` set rather than waiting for the intentionally frozen transcript tail, then renders each real phase in the same React pass rather than mirroring it through effect-driven state. A first generic frame uses `Thinking`, generic between-step status retains the latest useful phase, and live phase labels enter without changing the row height. Settled turns retain the header as `Worked for <duration>`. A chevron is present only when the turn has disclosed activity, and reopening it restores the process rail. The composer keeps its separate `StatusRow` for task/abort accessories.
- `TurnActivityRail.tsx` mounts only the latest 40 tool activities initially and reveals earlier batches on demand via **Load earlier activity**, which renders only while the rail is expanded. A rail that has never been opened remains unmounted; after its first opening, closing hides but retains the lightweight rows so reopening does not remount settled tools or replay arrival work. Individual tool bodies remain unmounted while collapsed. Memoized per-tool row boundaries and stable event callbacks isolate disclosure and popup updates to the affected tool. Stable tool IDs drive arrival transitions; activity order remains authoritative across assistant records.
- Thinking blocks auto-expand while their own part is streaming, inside a `max-h-80` pane that scrolls internally (plain text, not markdown). They collapse as soon as that part's `streaming` flag clears (the next text or tool part starts). **Collapsed by Default** off keeps a one-line header during stream and after unless the user expands it. Markdown mounts only after the part settles.

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Read or Skill in compact mode":

1. Edit `StaticToolRow.tsx` -> `getToolShortDescription(activity)`.
2. Update the branch that handles file reads or classified skill reads in `StaticToolRow`.
3. Keep all other tool header/output behavior in `ToolPart.tsx`.
4. Keep icon changes (if any) in `toolPresentation.tsx`.

Why: only navigation tools use the compact static path; all other tools need observable input and output.

## "I want tool to become expandable" (example)

1. Update `toolRenderUtils.ts`:
   - add/remove a tool name from `STATIC_TOOL_NAMES` only when it has a reliable direct in-app navigation action
2. Ensure `ToolPart.tsx` supports desired header + expanded output format for that tool.
3. Validate live streaming of assistant text and tools.

## Safe editing checklist

- Do not duplicate icon logic; keep it in `toolPresentation.tsx`.
- For static tool copy/navigation changes, edit `StaticToolRow.tsx`.
- For expanded output changes, edit `ToolExpandedContent.tsx`; keep row lifecycle/header changes in `ToolPart.tsx`.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Quick map of files in this folder

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Tools: `ToolPart.tsx`, `ToolExpandedContent.tsx`, `useDeferredExpandedContent.ts`, `ToolPartDiffPreview.tsx`, `PlainDiffFallback.tsx`, `StaticToolRow.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning: `ReasoningPart.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
