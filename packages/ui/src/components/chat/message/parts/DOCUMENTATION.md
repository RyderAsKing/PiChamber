# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static grouped tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows and grouped static tools.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change how `read/grep/perplexity/webfetch/...` look in compact/grouped mode, edit here.

- `ToolPart.tsx`
  - Renders expandable tool rows (bash/edit/write/question/task + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - If you want to change expandable tool layout, edit here.

- `taskToolModel.ts`
  - Owns Task metadata parsing and child-session summary projection.
  - `part.state.metadata.sessionId` is the only live identity contract between a Task and its child session.
  - A running Task may briefly have no `sessionId`; render it as waiting until the authoritative part update arrives. Never match parallel children by order, title, timestamp, or status.
  - Part-level metadata and output parsing exist only for older persisted records and never override state metadata.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

- Assistant markdown treats raw HTML as inert visible text. The final generated
  HTML is sanitized as defense in depth, with script and style elements
  forbidden, so message content cannot inject active DOM or application-wide
  CSS into any runtime surface.
- `read` and `skill` are **static navigation tools** and render via `StaticToolRow`.
- Every other tool, including search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`.
- The managed `pichamber` plugin tool uses the expandable path and hides its broad protocol input. The plugin supplies the selected action's human description as the native tool title; the UI renders that metadata without owning an action map. The full versioned result envelope renders through the same neutral JSON summary/tree/raw views as other tools, without a tool-specific output card.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render. Settled historical tools whose output or patch exceeds the render-record budget arrive as `state.deferredBody` stubs; expanding hydrates the canonical reducer part through `useSessionReducerPart` instead of keeping full bodies in every transcript record.
- The message list folds settled history turns older than the most recent two behind a centered **Load older history** control. That control reveals the two turns immediately above the visible window; **Load all history** restores every folded turn. Neither action changes the session log. Settled tools in a completed non-working turn collapse into a centered **Show N tools** control once the count reaches eight, including recent turns that folding does not hide. During a stream, token updates patch only the live assistant record when part membership is unchanged; sibling messages and turn activity keep their previous identities so they do not rebuild with the growing text.
- The rich tool diff preview lives in `ToolPartDiffPreview.tsx` and is lazy-loaded from `ToolPart`. It is the only tool-card piece that imports the `@pierre/diffs` + Shiki rendering stack, keeping that stack out of the eager chat startup graph. While its chunk loads (first rendered diff only) the plain-text patch from `PlainDiffFallback.tsx` renders as the Suspense fallback, mirroring the preview's error fallback. `ToolPart` itself must not statically import `@pierre/diffs` runtime modules or `@/lib/shiki/appThemeRegistry`.
- Running bash output falls back to `state.metadata.output` until canonical `state.output` arrives. Live output keeps at most 16 lines in the DOM (DeepSeek's terminal card cap) inside a compact viewport; it follows new output until the user scrolls up, then resumes following when the user returns to the bottom. Live output appends or replaces rewritten snapshots as plain text without worker highlighting; finalized output normalizes ANSI terminal controls with a bounded synthetic-cell budget, bypasses the throttle, and receives the normal one-time highlighted rendering.
- Thinking and justification blocks show duration when timing is available (`ReasoningPart.tsx` + `JustificationBlock.tsx`).
- The last assistant message in a settled turn renders a footer in `MessageBody.tsx` (model name, optional thinking variant, duration, timestamp). It stays hidden only while that assistant is in the live reducer `streamingMessages` set. Catalog or session `busy` after the stream ends must not keep the last-turn footer unmounted; older turns already skipped that heuristic because they are not the latest turn.
- Thinking blocks auto-expand while their own part is streaming, inside a `max-h-80` pane that scrolls internally (plain text, not markdown). They collapse as soon as that part's `streaming` flag clears (the next text or tool part starts). **Collapsed by Default** off keeps a one-line header during stream and after unless the user expands it. Markdown mounts only after the part settles.

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Read or Skill in compact mode":

1. Edit `ProgressiveGroup.tsx` -> `getToolShortDescription(activity)`.
2. Update the branch that handles `read` or `skill` in `StaticToolRow`.
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
- For static tool copy changes, prefer `ProgressiveGroup.tsx` first.
- For expanded output changes, edit `ToolPart.tsx`.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Quick map of files in this folder

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Tools: `ToolPart.tsx`, `ToolPartDiffPreview.tsx`, `PlainDiffFallback.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
