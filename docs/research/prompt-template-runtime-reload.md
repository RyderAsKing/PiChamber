# Prompt-template runtime reload without disposing sessions

**Reviewed:** 2026-09-04
**Pinned:** [`v0.84.1`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts) (`53fa77c`)
**Current upstream:** [`main @ 17de82d`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts) (2026-09-04)
**In-flight upstream:** [`flexible-reload @ 13b6839`](https://github.com/earendil-works/pi/compare/main...flexible-reload) (2026-07-23, unmerged)
**SDK docs:** https://pi.dev/docs/latest/sdk
**Scope:** official reload semantics relevant to picking up edited prompt-template (`.md`) files on a live `AgentSession` without dispose/reopen.

## Bottom line

Upstream already owns the primitive PiChamber needs: **`AgentSession.reload()`** is public and byte-identical in `v0.84.1` and current `main`. It reloads settings, providers, and the full `ResourceLoader` catalog (extensions, skills, **prompt templates**, themes, context files, system prompt), then rebuilds the extension runner and tool registry **in place** — session file, session ID, and transcript are untouched and `dispose()` is never called. That makes it strictly cheaper than the dispose-plus-reopen path, which reopens at the persisted file tail.

The catch is safety, not capability. On pinned and `main`, `reload()` itself has **no streaming/compaction guard and no concurrency control**; the only guards live at the TUI call site (`/reload` and command-context `ctx.reload()` both funnel into `handleReloadCommand`, which refuses while `isStreaming`/`isCompacting`). The unmerged `flexible-reload` branch fixes exactly this with a deferred `requestReload()` design — worth tracking, not depending on yet.

For pure `.md` prompt-template edits, `session.reload()` while idle is the sound call: it covers catalog re-read plus the extension/tool/system-prompt knock-ons. `resourceLoader.reload()` alone would refresh the next `/name` expansion (the prompt path reads the loader live) but skips the extension lifecycle, tool-registry rebuild, and settings/provider refresh.

## Verified upstream behavior

### `reload()` preserves identity and transcript (v0.84.1 == main)

The reload body is identical in both refs ([v0.84.1 `agent-session.ts#L2610-L2636`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts#L2610-L2636), [main `agent-session.ts#L2818-L2844`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts#L2818-L2844)):

1. snapshot flag values from the old runner
2. `emitSessionShutdownEvent(oldRunner, { reason: "reload" })`, then `oldRunner.invalidate()`
3. `settingsManager.reload()` + `syncQueueModesFromSettings()` + `resetApiProviders()`
4. `this._resourceLoader.reload()` (re-reads prompt `.md` files among everything else)
5. `_buildRuntime({ activeToolNames: this.getActiveToolNames(), flagValues, includeAllExtensionTools: true })` — active tool set and flag values carry over; newly registered extension tools are auto-included
6. if the host bound extension bindings, run `beforeSessionStart`, emit `session_start` with `reason: "reload"`, then `extendResourcesFromExtensions("reload")`

What it does **not** touch: `sessionManager` (so [`sessionFile`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts#L970-L976)/session ID/leaf are stable), `agent.state.messages`, or the subscription list. Contrast [`dispose()`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts#L839-L862), which aborts everything, invalidates the runner, disconnects from the agent, and drops listeners — `reload()` calls none of that.

### Prompt catalog refresh

- Discovery: [`loadPromptTemplates()`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/prompt-templates.ts#L194-L263) reads global `<agentDir>/prompts/`, project `<cwd>/.pi/prompts/`, and explicit `promptPaths` (files or directories, `*.md` only, name = basename minus `.md`). This matches the SDK docs' Directories section (https://pi.dev/docs/latest/sdk).
- Refresh trigger: [`DefaultResourceLoader.reload()`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/resource-loader.ts#L387-L401) clears the extension cache on repeat loads, preserves `SettingsManager.projectTrusted`, re-resolves package/CLI paths, and re-runs [`updatePromptsFromPaths()`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/resource-loader.ts#L694-L718) (re-applying any `promptsOverride`). Identical on `main`.
- Consumption is live: [`session.promptTemplates`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts#L995-L997) delegates to `resourceLoader.getPrompts()` on every access; [`prompt()`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts#L1163-L1165) expands via `expandPromptTemplate(text, [...this.promptTemplates])`, and the slash-command listing in `_bindExtensionCore` maps `this.promptTemplates` fresh per call. So after `reload()`, the next `/name` prompt and the next completion list see edited, added, or removed templates. Edited-file content, renames (new name appears, old disappears), and deletions all resolve at the next reload — no file watcher exists upstream; reload is explicit.
- Extension-contributed prompts re-merge after runner rebuild via `extendResourcesFromExtensions("reload")` → `loader.extendResources()` + base system-prompt rebuild.

### Extension lifecycle effects

- Events (typed in [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/extensions/types.ts#L543-L565)): `session_shutdown` with `reason: "reload"` (emitted only if a handler exists, per [`emitSessionShutdownEvent`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/extensions/runner.ts#L192-L204)), then `session_start` with `reason: "reload"`, then `resources_discover` with `reason: "reload"`.
- Old-context invalidation is hard: [`ExtensionRunner.invalidate()`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/extensions/runner.ts#L543-L551) poisons the old runtime; any later use of a captured `pi`/command ctx throws the stale-context error. Extension code after `await ctx.reload()` keeps running in the old frame and must not assume old in-memory state is valid (documented in `extensions.md`; the `flexible-reload` rewrite keeps this rule).
- Host bindings (`uiContext`, command actions, abort/shutdown/error handlers) are re-applied to the new runner, but the post-reload `session_start` + `resources_discover` round only runs `if (hasBindings)`. PiChamber binds extensions per runtime (`createPiSessionRuntime` → `session.bindExtensions(...)` in `packages/web/server/lib/pi/session-daemon/session-daemon.js`), so the full round applies there.

### Idle/streaming safety and concurrency (pinned + main)

- `reload()` has **no `isStreaming`/`isCompacting` check, no lock, no deferral**. A mid-run call would swap the extension runner, tool registry, and system prompt under a live turn, and two overlapping calls interleave (both rebuild from whatever `getActiveToolNames()` returns mid-flight).
- Safety is enforced one layer up in the TUI: [`handleReloadCommand`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5676-L5729) warns and returns on `isStreaming` ("Wait for the current response to finish before reloading") and on `isCompacting`. The command-context `reload` binding routes to the same handler, so extension `/reload`-style commands inherit the guard. Same on [main](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5942-L5995).
- PiChamber-side note (not upstream): the session daemon only disposes idle runtimes when the session is neither streaming nor compacting (`disposeIdleSessionRuntime` in `session-daemon.js`). Any PiChamber reload entrypoint should apply the same idle predicate before calling `session.reload()`.

### What `flexible-reload` changes (unmerged, 1 commit ahead of its base)

Per [the `main...flexible-reload` compare](https://github.com/earendil-works/pi/compare/main...flexible-reload) (HEAD `13b6839`, "defer extension reload requests safely"):

- New `session.requestReload()` + `withReloadDeferred()`: reload requests during streaming, compaction/branch-summary, or inside guarded sections (`prompt()` preflight→settle, `_runAgentPrompt`, model/thinking-level events, `user_bash`, session-before-switch/fork teardown) set a flag and flush at the next safe boundary instead of running immediately.
- `reload()` becomes a thin wrapper over a coalescing `_runReloadHandler`: a request arriving while a reload is in flight queues exactly one follow-up, executed when idle; reload errors are routed to the extension error channel.
- Host-owned reload execution: new `reloadHandler` binding lets the TUI run UI teardown around the core (`performReload(reloadCore)`), while command/extension contexts call `requestReload()`.
- `ctx.reload()` is promoted from command-only to all of `ExtensionContext` (tools, event handlers, shortcuts), documented in the rewritten `extensions.md` `ctx.reload()` section: request resolves on acceptance; execution deferred to a safe boundary; handler must treat reload as terminal and return `terminate: true` from tools when the reload should land as soon as the turn ends. A new `agent-session-reload-request.test.ts` pins the deferral ordering (`tool_execute → reload_requested → agent_end → reload`).

## Recommended PiChamber posture

1. For prompt-template file changes, call `session.reload()` on the live session **while idle** (`!isStreaming && !isCompacting`). This preserves session identity/transcript and refreshes prompts plus extensions/tools/settings in one step. Do not dispose/reopen just to refresh templates.
2. `resourceLoader.reload()` alone is a narrower option (fresh `.md` content for the next expansion with zero extension churn) but leaves tools, extension-registered commands, and the system prompt stale — prefer the full `session.reload()` unless that churn is deliberately unwanted.
3. Gate every reload entrypoint on the same idle predicate the daemon already uses for idle disposal, and serialize concurrent reload requests (upstream has no lock on pinned/`main`). Surface reload failure without clearing transcript state.
4. Watch `flexible-reload` before building extension-triggered reload UX: its `requestReload` + `reloadHandler` contract is the likely upstream answer to safe mid-run reloads, but it is unmerged and its base is ~1200 commits behind current `main`.

## Limitations and open questions

- `flexible-reload` is unmerged and behind `main`; its API (`requestReload`, `withReloadDeferred`, `RuntimeReloadCore`) may change or never land. Pinned/`main` behavior above is what PiChamber 0.84.1 can rely on.
- The pi.dev SDK page's `AgentSession` interface excerpt omits `reload()` entirely, and repo `sdk.md` only demonstrates `loader.reload()` per resource type — the reload contract is source- and `extensions.md`-owned, so future doc edits could shift the recommended surface.
- PiChamber daemon internals were sampled only for lifecycle predicates (binding + idle disposal); the exact place to thread a reload command/route was not traced, and no product code was changed in this research.
- Upstream has no file watcher for prompt directories; staleness between a `.md` edit and the next explicit reload is expected behavior, not a bug.

## Sources

Upstream Pi, pinned to `v0.84.1` (`53fa77c`):

- [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts) — `reload()` L2610, `bindExtensions()` L2237, `promptTemplates` L995, `dispose()` L839, `isStreaming`/`isIdle` L878/L883
- [`packages/coding-agent/src/core/resource-loader.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/resource-loader.ts) — `reload()` L387, prompt refresh L487/L694
- [`packages/coding-agent/src/core/prompt-templates.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/prompt-templates.ts) — discovery L194, expansion L269
- [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/sdk.ts) — owned-loader `reload()` L183
- [`packages/coding-agent/src/core/extensions/runner.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/extensions/runner.ts) — shutdown emit L192, `invalidate()` L543
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/extensions/types.ts) — `resources_discover` L544, `session_start` L562, `session_shutdown` L616
- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/modes/interactive/interactive-mode.ts) — `handleReloadCommand()` L5676, reload call L5729
- [`packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/sdk.md) — `loader.reload()` usage per resource
- [`packages/coding-agent/examples/sdk/08-prompt-templates.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/examples/sdk/08-prompt-templates.ts)

Current upstream (`main @ 17de82d`, 2026-09-04): same `agent-session.ts` reload body at [L2818](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts#L2818-L2844), same `resource-loader.ts` reload at [L388](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/resource-loader.ts#L388-L401), same TUI guards at [L5942](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5942-L5995). Only nearby-line drift versus `v0.84.1` (notably `isIdle` now also excludes compacting).

In-flight branch: [compare `main...flexible-reload`](https://github.com/earendil-works/pi/compare/main...flexible-reload) (branch HEAD `13b6839`, 2026-07-23).

PiChamber sources (read-only, unchanged):

- `packages/web/server/lib/pi/session-daemon/session-daemon.js` — per-runtime `bindExtensions`, idle-disposal guards
- `packages/web/package.json` — pinned `@earendil-works/pi-coding-agent@0.84.1`

No file restoration or dedicated `revert` verb was involved; no code or runtime behavior was changed during this research.
