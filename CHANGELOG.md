# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.8.0] - 2026-09-03

Snippets, prompt templates, command catalog, streaming polish, and architecture consolidation release.

- **Snippets and prompt templates are now first-class.** Server adds a PiChamber snippets store backend with CRUD plus native commands catalog routes; Pi client and protocol are directory-scoped with snippets and commands. UI adds an ID-based snippets store with directory-scoped UI, a prompt-templates store/page with variable helpers, insert-only draft starters pinned to prompt templates (including one-time built-in text starters on the new-session welcome screen), and separate Snippets vs Prompt-templates settings surfaces with search. Skill mentions render as `/skill:name` links.
- **Composer slash and skills align with Pi resolution.** Adds a shared command catalog with executable invocation identity, clears runtime-scoped catalogs on endpoint reset, and integrates the catalog into the composer. Removes PiChamber-owned slash commands, refines command source filters, and keeps extension-command sessions on the composer-first empty surface. Session titles gain a shared helper with awaiting-first-prompt titles, and awaiting-first-prompt label plus extension toast delivery are fixed.
- **Chat streaming polish (#79, #80).** Fluid streaming arrivals with live tool/thinking shimmer and stable footers, stabilized streaming footers and tool states, pixel-grid Dots loader with shimmer status and footer arrival fade, and a copy button next to the composer branch name. Also removes the composer drag ring while keeping drop overlay edges distinct and widens chat columns (60rem base, 76rem wide).
- **Faster, more reliable new-session sends.** New-session sends show instant pending feedback, preserve feedback through dispatch, hide empty assistant echo until first renderable content, and speed up dispatch. Attachment drafts survive session switches with files kept consistent through send and render; relay connects fail fast with diagnostics instead of hanging on stall and handle already-connected host state.
- **Mobile and desktop UI polish.** Mobile new-session action moves to a floating button at the sidebar bottom, stale mobile header on session switch is fixed, composer changes trigger and header alignment are corrected, working loader type matches the stream with tool-sized timer, desktop header title/metadata collapse to a single line, performance overlay is draggable, model picker drops sorting/footer, and worktree close gains a safe confirmation flow.
- **Reduced surface.** Removes legacy desktop SSH instance manager, AI commit generation, deprecated context workflows, obsolete project notes surface, and dead presentation wrappers; docs align with the reduced feature surface. Attachment filename CORS header is allowed for browser uploads.
- **Architecture consolidation preserving behavior.** Stacked on `pichamber/reduce-size-p1`, this is a behavior-preserving consolidation that merges duplicated mobile/desktop Files and Git implementations, decomposes large config, UI, Git, session, persistence, chat, message, tool, and composer modules into focused owners (including shared Files/Git mobile chrome), cleans up the runtime Git contract, and removes shallow/dead wrappers; review fixes restore private relay client URL parameters (`v`, `role`, `serverId`, optional `grant`) and retryable handshake timeouts with regression tests.

## [0.7.2] - 2026-09-01

Attachments, worktree, extension, and startup reliability release.

- **Attachments upload before the prompt leaves.** Composer picker, drop, and paste now create card previews immediately and stream each file to `POST /api/pi/attachments` as `application/octet-stream` with `x-pichamber-filename`/`x-pichamber-mime` before prompt dispatch. The composer shows one strip inside the card that wraps on wide layouts and scrolls on narrow layouts; each card reads its own `preparing` / `uploading` (determinate progress when the runtime reports bytes) / `ready` / `failed` / `expired` state from `input-store.ts` with Retry and Remove actions. `Send` and `Queue` are gated until every draft attachment is `ready` (`Uploading attachments…` / `Retry or remove failed attachments` on the send/queue buttons and as toasts), keyboard submission repeats the gate, and queueing detaches cards without deleting server uploads. Prompt dispatch keeps cards visible until Pi accepts the prompt; payload-too-large, network, and runtime-changed failures leave attachments available for another attempt instead of clearing them. Server validates filenames, enforces expiry/TTL and per-file limits in `attachment-store.js`, supports `DELETE /api/pi/attachments/:id`, and the web client exposes `uploadAttachment`/`deleteAttachment` plus `runtime-upload.ts` progress reporting. Queued messages serialize ready attachments for persistence and restore (`#70`, `runtime-upload`, `attachment-store`, `ChatInput`, `FileAttachment`, `input-store`, `session-ui-store`).
- **Background worktree creation no longer steals focus.** The submit that starts a draft worktree captures its draft snapshot, prompt, and model config and keeps the returned receipt through completion. Selecting another session while the worktree builds no longer redirects the prompt or steals session focus; materialization creates the worktree session with `select: false` and prompts its new directory in the background, leaving the current session and active directory untouched. Failure preserves the draft and never falls back to the source checkout (`#71`, `useDraftWorktreeCreation`, `pi-session-store`, `session-ui-store`, `session-actions`).
- **Extension state hydrates on open and reconnect.** `sessions.open` and `session.snapshot` now include live extension state (`extensionStatuses`, `extensionWidgets`, `extensionDialogs`, `extensionPanels`, `extensionApps`, `extensionTitle`) built by `projectExtensionSnapshotState` and seeded from the daemon's per-session maps. First attach after a cold start no longer misses one-time startup statuses before the browser stream connects, and a second tab reopens with the same live panels (`#75`, `session-daemon`, `routes`, `event-reducer`, `bootstrap`, `reconnect`).
- **Large settled history no longer rebuilds on every token.** Settled assistant turns with long histories defer older blocks behind `Load older history` / `Load all history` (deterministic `TurnAssistantBlock` + `turnAssistantReveal`), so live replies avoid rebuilding the whole transcript and `MessageList` virtualization stays cheap (`#73`, `MessageList`, `TurnItem`, `TurnAssistantBlock`).
- **Interactive `startup enable` and `pichamber version`.** In an interactive terminal with no setup flags, `pichamber startup enable` now walks through access (`This machine only` / `Local network` / `Custom bind address`), port (1–65535 validated), authentication (`Use configured password` / `Enter a password` with confirmation / `Generate a secure password` / `No password` when local), and a final confirmation before installing the native service. Flag-driven, non-TTY, `--quiet`, and `--json` runs stay non-interactive. Re-running enable rewrites and restarts the systemd unit (`daemon-reload` + `enable` + `restart`) so new settings take effect instead of requiring a manual restart. Adds `pichamber version` (and `--version`) that prints the installed package version and supports `--json` (`bin/cli`, `cli-args`, `commands-startup`, `cli-startup`, `DOCUMENTATION.md`).
- **Web updates use the correct Pi endpoint and a detached launcher.** The client now posts to `POST /api/pi/update-install` (was `/api/pichamber/update-install`) and the server validates the install is a trusted global package-manager copy before spawning a detached updater (`pichamber update --quiet`, `detached` + `stdio: ignore`). Container and systemd-hosted servers are refused with an actionable message instead of attempting an in-place replace (`#74`, `UpdateDialog`, `routes`, `package-manager`, `launchUpdateCommand`).
- **Directory focus no longer loops on Windows spellings.** The chrome bridge compares normalized path identities (slash style, drive-letter case, trailing separator) before writing the daemon focus back into `useDirectoryStore`, preventing an update loop between `C:\\repo` and `C:/repo/` (`AppEffects`, `normalizePath`).

## [0.7.1] - 2026-09-01

Composer, project, and desktop-auth polish after 0.7.0.

- **Thinking changes wait until send.** Composer thinking-level picks stay local until the next send, so mid-turn or idle picker changes no longer rewrite the active session (`apply-composer-thinking`).
- **Skills trust without a popup.** Opening a project no longer shows a trust dialog for skills; PiChamber projects are trusted automatically.
- **Worktree create stays in the background.** Creating a worktree shows global progress instead of blocking the composer, so you can keep chatting while checkout finishes (#66).
- **Desktop reload keeps the last host unlocked.** Reloading an Electron window reapplies the stored client token for the hydrated last runtime before the password gate runs (`restoreDesktopRelayRuntime`, #65).
- **Projects settings match other pages.** The Projects settings page follows the Providers/Skills layout, and the Settings nav no longer repeats the PiChamber heading (#63, #69).
- **UI polish.** Left sidebar border removed, tablet composer padding and header burger aligned with desktop, and the OpenAI logo shows for the `openai-codex` provider (#64).

## [0.7.0] - 2026-09-01

Streaming reliability and faster session startup.

- **Live turns survive reload.** Reopening a chat that is still running restores the working/tooling state from `getSession` (`isStreaming` / `lifecycle: 'busy'` plus in-flight tools) instead of showing a settled transcript until the next token.
- **Event stream stays attached.** Transport switches reconnect from the last accepted sequence without treating a disconnect as an empty session. Missed replay windows force-hydrate from an authoritative snapshot.
- **Remembered desktop host auth.** Reloading an existing Electron window reapplies the selected remote host URL and stored client token so a remembered password is not prompted again (`startup-url-selection`, `main.mjs`).
- **Warm sidebar catalog.** Stable session-list metadata is cached per runtime and restored as idle rows before directory lists return. Failed folder refreshes keep cached rows; authoritative empty lists persist an empty tombstone. Busy/retry and hydrated transcripts are never restored from cache (`pi-session-catalog-cache`).
- **Faster crowded folder lists.** `sessions.list` reads up to eight JSONL session files at a time in a directory. One unreadable or header-malformed file still fails that folder only.

## [0.6.0] - 2026-08-25

Worktree-aware sidebar and no-folder session fixes.

- **Worktree-specific busy indicator.** When a project has linked worktrees, the sidebar now shows the busy spinner on the exact worktree that is running. Collapsed projects aggregate activity on the project row; expanded projects show the spinner only on the primary checkout or the linked worktree that is actually busy. Single-project and no-worktree behavior is unchanged (`SessionSidebar` → `activeDirectoriesByProject`, `SidebarSpacesBar` per-worktree `AgentThinkingLoader`).
- **Sessions without a folder stay global.** Sessions created with “Don’t work in a folder” at literal `~` no longer leak into every registered project’s ownership bucket or focused catalog slice, so switching folders cannot retain or select an unrelated home session. `isKnownActiveSessionDirectory` and directory-ownership logic now scope correctly to authoritative known directories and global session home, with header location hiding the stale active project for home sessions (#59).
- **Electron update manifest verification handles multiple artifacts.** `verify-update-manifest.mjs` now finds the expected artifact by matching its URL among multiple `files` entries instead of requiring exactly one, fixing checksum validation for macOS `latest-mac.yml` which lists both DMG and ZIP.
- **Sidebar labeling.** “All sessions” is now labeled “All Folders” across the sidebar and docs; global/home sessions carry the neutral “No folder” shade and correct empty states when no folder is selected.

## [0.5.2] - 2026-08-25

Folder-scoped session reliability release.

- **Folder switching shows the correct sessions.** Home sessions no longer enter every registered project's ownership bucket or focused catalog slice, so changing folders cannot retain or select an unrelated home session.
- **Explicit no-folder sessions.** The new-session picker always offers "Don't work in a folder" at literal `~`, whether the runtime home is registered as a folder or not. The selection remains stable instead of snapping back to the active project.
- **All folders keeps global sessions accessible.** Sessions created at `~` appear only in All folders, carry a "No folder" secondary label, and use a neutral theme-aware background. Project views remain strictly folder-owned.
- **Release integrity.** Desktop release jobs independently verify macOS, Windows, and Linux updater-manifest checksums against their generated artifacts. The npm job publishes the exact attached tarball and verifies its SHA-512 integrity, SHA-1 shasum, and downloaded registry bytes.

## [0.5.1] - 2026-08-25

Focused composer and reload reliability release.

- **Repository-free sessions.** The new-session folder picker now offers "Don't work in a repository", creates the session in the connected runtime's home directory, and shows those home sessions in every project folder. Literal `~` and expanded-home catalog entries merge without duplicate rows.
- **Reload restores context.** Reloading the web or desktop renderer preserves the selected runtime and its last active session instead of reverting to Local server. Runtime endpoint persistence remains credential-free, and Capacitor mobile keeps its existing validated restore flow.
- **Safe worktree names.** Small-model utility inference now runs in an isolated Pi text-transformation session without coding-agent instructions, repository context, skills, extensions, templates, or tools. Worktree naming accepts only a complete lowercase ASCII hyphenated slug within 48 characters; conversational or malformed replies fall back to the deterministic task-derived name.

## [0.5.0] - 2026-08-24

Pi extension release: existing extensions now run inside PiChamber's session daemon, their commands and standard UI prompts work across clients, and extensions can add native cards, panels, forms, and sandboxed app views to the workspace.

- **Pi extensions run in PiChamber.** The session daemon loads global and trusted project extensions through Pi's standard discovery flow. Registered tools, commands, lifecycle hooks, prompt modifications, and session state work without a PiChamber-specific dependency; child-process extensions resolve the real `pi-coding-agent` binary inside the detached daemon (`session-daemon`, `extension-bridge`).
- **Extension dialogs and live UI.** Standard `ctx.ui` select, confirm, input, editor, notification, status, and widget calls render in web, desktop, hosted mobile, and Capacitor clients. PiChamber's versioned extension protocol adds validated markdown, key-value, list, table, progress, badge, and code cards; reconnect-safe live panels; structured forms; command actions; and script-only sandboxed app views (`extension-protocol`, `extension-ui`, `ExtensionDialogOverlay`, `ExtensionStatusWidgets`, `ExtensionMessageCard`, `ExtensionPanelDock`, `ExtensionAppSurfaces`).
- **Extension commands in the composer.** Registered slash commands appear in autocomplete and dispatch to their extension with arguments. Settings can pin commands as composer buttons and bind global shortcuts without shadowing built-in shortcuts (`CommandAutocomplete`, `ComposerCommandTriggers`, `CommandTriggersSettings`).
- **Extension state stays in sync.** Model and thinking-level changes made by commands such as `/balance` or `/juicer` now update the composer instead of being overwritten by stale local selection. Dialog responses are validated, ANSI and truecolor dialog content is normalized on mobile, notifications appear as toasts and transcript cards, and extension listings expose opaque IDs rather than host paths (`model-selection-sync`, `ansi`, `extension-bridge`).
- **Faster worktree switching.** Changing sessions or worktrees no longer recreates the project list. Filtered worktree views remove redundant group headers and indentation, while draft target controls and pending-change details are more compact (`useProjectsStore`, `SidebarProjectsList`, `SidebarSpacesBar`, `DraftTargetSelectors`, `PendingChangesBar`).
- **Mobile composer polish.** Speech recording no longer shows a timer that crowds the mobile composer, and long model and thinking-level labels use tighter limits (`ComposerVoiceInput`, `ModelControls`, `ThinkingLevelControl`).
- **Pi-native cleanup.** The remaining internal OpenCode compatibility clients, status/config helpers, route aliases, and fallback contracts have been removed. PiChamber now uses the Pi-native session, settings, Git, and runtime paths directly.
- **Release integrity.** npm publishing now publishes the exact tarball attached to the GitHub Release, then verifies its SHA-512 integrity and SHA-1 shasum against npm metadata and the registry download before attaching it (`release.yml`).

## [0.4.0] - 2026-08-24

Worktree, composer, skills and voice release: linked Git worktrees become first-class peers, branch checkout is deferred until send, Pi skill reads render as navigation rows, and final-only speech dictation ships with waveform feedback.

- **Git worktree integration.** Linked worktrees are auto-discovered via `git worktree list --porcelain` regardless of filesystem location and owned by their registered project — never as separate projects. The composer folder picker and sidebar show them as indented branch rows under the owning project; selecting one filters sessions and targets `New session` without registering another project. A new `Current checkout` / `New worktree` composer mode treats the selected branch as `Start from`, derives a `pichamber/<name>` branch with the configured small model (local slug fallback, never blocking), creates the worktree without mutating the source checkout, waits for `setup-ready` (`Creating worktree…` → `Checking out files…` → `Setting up project…` → `Starting session…`), then creates and sends against the server-confirmed directory. Failures preserve the draft and prompt and never fall back to the source checkout. Server adds `GET /api/git/worktrees`, `POST /api/git/worktrees/validate`, `POST /api/git/worktrees`, `GET /api/git/worktrees/bootstrap-status` and `POST /api/pi/small-model/generate` (Pi-native one-shot, no tools/persistence); `getWorktrees` now exposes `isPrimary`/`detached`/`locked`/`prunable` and throws on failure; runtime-scoped discovery is coalesced, visibility-bounded and preserves the previous list on failure (`useWorktreeStore`, `worktree-discovery`, `pi-session-catalog-feeder`, `known-session-directories`, `sessionOwnership`, `projectResolution`, `useConfigStore`, `ChatInput`, `small-model-generation`).
- **Composer defers branch checkout until send.** Picking a different branch now records a directory-and-runtime-scoped draft intent without touching Git; the first send confirms surrounding sessions and completes checkout with `expectedCurrent` + `localOnly` preconditions before creating the session, with a dedicated confirmation dialog when other local branches would be disrupted (`useDraftTarget`, `useDraftBranchCheckout`, `DraftBranchCheckoutDialog`, `DraftTargetSelectors`, `session-ui-store`).
- **Pi skill reads render as navigation rows.** `skill` tool calls render as compact navigation rows like file reads, with pill alignment and hidden `id`, improving skill discoverability on desktop and mobile (`skillToolPresentation`, `ProgressiveGroup`).
- **Final-only speech dictation.** Composer gains hold-to-talk dictation with final-only transcripts, canvas waveform visualizer, audio worklet capture, thinking-level slider and mobile footer integration; no provider is required beyond the model catalog (`dictation-client`, `audio-capture`, `audio-worklet`, `ComposerVoiceButton`/`Visualizer`/`Input`, `DictationSettings`). Includes `fix(ui): keep dictation composer height stable`, `perf(ui): scroll dictation waveform on canvas`, and `feat(ui): align dictation controls with composer footer`.
- **Remote development WebSocket fix.** Authenticated dev WebSockets are now proxied through the PiChamber server so HMR and provider streams remain authenticated on remote hosts (`fix(web): proxy authenticated dev websockets`).
- **Mobile parity fixes for v0.3.2 / v0.3.3.** Subtask "Open subtask session" now closes the sessions sheet and workspace drawer on dedicated mobile after switching sessions (`MobileApp`, `mobileAppContext`, `MessageBody`); fork-family accent paints a 3px solid `borderLeft` on phone/tablet where the previous 11% wash was invisible against `bg-sidebar` (`forkFamilyColor`, `SessionNodeItem`); persisted `ui-store` v16→17 re-sanitizes `contextPanelByDirectory` and strips `chat` from `contextRailOrder` for stale hosted-mobile tablet tabs (`useUIStore`); four `Refresh catalog` / `Refresh providers` buttons use `size="sm"` on mobile to hit the 36px touch target (`ProvidersPage`).
- **Polish.** Sticky folder label deduplication, fork session prompting and mobile color fixes, and docs for Git worktree and small-model generation.

## [0.3.3] - 2026-08-22

Hotfix for the 0.3.2 desktop startup crash.

- **Fixes immediate Electron crash on every platform.** 0.3.2 shipped a regression in the retry-limit feature: the session daemon imported the PiChamber data-root from `../pichamber-data-dir.js` instead of `../../pichamber-data-dir.js`, so the Electron main process (and the web server) failed at startup with `ERR_MODULE_NOT_FOUND`. The import is now correctly resolved and the desktop app again starts and serves the Pi session daemon (`session-daemon`). Re-bundle the Electron main (`bundle:main`) after this change; installed 0.3.2 users should update to 0.3.3 via `pichamber update` or the auto-updater.

## [0.3.2] - 2026-08-22

Remote access and consistency release: remote terminal works over LAN/tunnel again, agent run duration is identical on every device, desktop clients can pair new devices, and Cloudflare Tunnel external access ships end to end.

- **Remote terminal WebSocket fix.** Browser WebSocket upgrades cannot send headers, so remote clients mint a 60-second `oc_url_token`; the server's URL-token gate had no WebSocket allowlist, so every non-local terminal connection failed with "HTTP Authentication failed". `/api/terminal/ws` is now an explicit URL-token WebSocket path (still origin-checked, still scoped, unknown upgrade paths still rejected), restoring remote terminals over direct LAN, reverse proxy, relay, and tunnel (`ui-auth`, `terminalApi`).
- **Consistent agent working duration across devices.** The daemon now owns the authoritative turn start: `session.lifecycle` busy/retry events, snapshots, and session details carry `runStartedAt` plus `serverNow`, and clients derive elapsed time from the server clock offset instead of local observation. Opening the same running session on a second device (or after reload/reconnect) shows the same duration instead of restarting from zero; completed/failed/interrupted turns settle identically everywhere (`session-daemon`, `routes`, `protocol`, `session-activity-timing`, `pi-session-store`).
- **User-configurable default retry limit.** Sessions settings gains a Default retry limit control (0–10 retries, default 3) persisted in the PiChamber sidecar and applied to new sessions through Pi's `retry.maxRetries`; explicit per-run values keep precedence. 0 disables automatic retries (`settings-store`, `session-daemon`, `DefaultsSettings`).
- **Cloudflare Tunnel external access.** A server-owned tunnel manager wires the previously unwired Cloudflare provider into the live server: quick, managed-remote (token + hostname), and managed-local modes with status, start/stop, doctor diagnostics, one-time bootstrap connect links, and secret handling that stores tunnel tokens mode-`0600`, reports only presence booleans, and redacts everything else. Routes are authenticated; docs cover setup, required Cloudflare token permissions, and systemd (`tunnel-service`, `server/index.js`, `install.mdx`).
- **Desktop clients can pair new devices.** Trusted paired-desktop client tokens may now create short-lived pairing tickets through a narrowly scoped auth path (separate from general device management, which stays UI-session/desktop-local only). Tickets stay one-time, time-limited, revocable, and rate-limited on redeem; mobile and other client kinds remain blocked from creating pairings (`core-routes`).
- **Forked sessions render like normal sessions.** The sidebar drops the nested fork tree and its dropdown: every session sits in the unified recency order, and fork families are identified by a deterministic per-family accent color derived from the family root ID — stable across clients, reloads, and restarts (`useSessionGrouping`, `SessionNodeItem`, `forkFamilyColor`).
- **Sidebar archive on touch devices.** The hover archive action is now desktop-only; tablets and phones manage archive/delete through the press-and-hold context menu, preventing accidental archives from ordinary taps (`sessionQuickActions`, `SessionSidebar`).
- **Provider model visibility fixes.** Show all / Hide all publish immediately and deduplicate reliably (rows re-render via the shared hidden-models check), and the Refresh catalog button is now an accessible icon button with loading state, disabled state, and success/error feedback (`ProvidersPage`, `useUIStore`).
- **Snippet editor opens in Write mode.** New snippet creation defaults to the Write tab; existing snippets still open in Preview and in-progress mode choices are never overwritten while editing (`SnippetMarkdownEditor`, `SnippetsPage`).
- **Root VPS installs work out of the box.** On Linux, root installations register a system systemd unit (`/etc/systemd/system/pichamber.service`, `multi-user.target`) instead of a user unit needing lingering, so `pichamber startup enable` survives reboot under root; user installs are unchanged. `pichamber update` restarts whichever scope is active and keeps configuration, env files, and data intact (`cli-startup`, `commands-update`).
- **Side panel chat removed.** The experimental "Open in Side Panel" surface, embedded chat iframe plumbing, and related theme/router guards are deleted; subtask links navigate in place and stale persisted panel state migrates away (`ContextPanel`, `useUIStore` v16, `useRouter`).

## [0.3.1] - 2026-08-22

Stability and cross-device reliability release. No new surfaces — every change is a targeted fix for live streaming, retry, revert, and daemon recovery discovered immediately after 0.3.0.

- **Cross-device stream recovery.** `EventSource` now resumes from the last accepted sequence after reconnect, so a session started on desktop rehydrates correctly on a second tab or phone without orphaning live messages. Native `EventSource` transport stays outside CapacitorHttp (which buffers SSE), and WKWebView dead-connection retention is handled by replacing rather than reusing the stalled stream. Hydrate vs. live merging was reworked so a newer fetch does not erase the partial transcript of a restarted client (`pi-session-store`, `transport`, `supervisor`, `session-daemon`).
- **Live message tree IDs are now alias-resolved.** Hydrated transcripts already carry Pi `entry.id`; live `message_start` synth IDs (`user-<session>-<n>` / `assistant-<session>-<n>`) are now mapped to the persisted entry ID by object identity at `message_end` and resolved before navigation/fork. The mapping is cwd+session scoped, survives idle daemon disposal, and clears on deletion/shutdown. Fixes revert/retry on messages created after the last hydrate and prevents synthetic parent references from orphaning turns in a second tab (`message-entry-aliases`, `session-daemon`, `session-ui-store`).
- **Pi retry lifecycle ownership.** The daemon is the single owner of the retry state: transient provider errors (`SessionRetry`, `continuing: true`) keep the session in `retry` instead of flipping to `error`, `session.lifecycle: retry` now carries `{ attempt, next, message }`, and the server projects the same retry meta on snapshots and event frames. The client treats `retry` as a live continuation so tool calls and follow-ups survive the retry window (`session-daemon`, `routes`, `protocol`, `event-reducer`).
- **Retry and tool continuation rendering.** The chat overlay keeps `retry` visible through Pi's preparatory `busy` frame and the next `assistant.message.start`, clearing only on accepted text/thinking/tool output. Error-ended assistants remain the active stream until a retry or terminal lifecycle clears the footer. The assistant working-state and `Retry` banner copy are corrected (`Retrying after an error:`), `continuing` assistant content is rendered without a spurious retry badge, and catalog/turn records upsert stubs so the sidebar never drops the session during a retry (`event-reducer`, `pi-session-catalog`, `applyRetryOverlay`, `MessageList`, `assistantWorkingState`, `sync-context`).
- **Revert restore is now durable.** The per-message revert control is hidden on the newest message (no-op navigation) while fork stays available. Partial restores keep the original pre-revert leaf; navigation state clears only after the abandoned branch is fully restored, so a second restore no longer goes backward. `restore`/`redo` now reject on failure and the `RevertedMessageDock` surfaces the error via toast instead of silently swallowing it. Companion alias fix for live assistant turns described above (`session-ui-store`, `session-actions`, `MessageRevertAction`, `message-entry-aliases`).
- **Windows daemon timeout recovery.** The supervisor treats `DAEMON_TIMEOUT`/`DAEMON_START_TIMEOUT` as recoverable, and the store's `reportError` keeps a transport-owned backoff loop alive even when the initial runtime probe failed before the SSE stream attached. On reconnect the store triggers an authoritative bootstrap instead of treating the stream itself as state, preventing Windows users from getting stuck in `error` after a slow daemon start (`supervisor`, `pi-session-store`, `pi-session-connection`).
- **Cross-tab retry alias is now sticky.** Canonicalizes streaming assistant IDs and mutation metadata to the hydrated Pi entry ID so a resumed SSE alias renders in a second tab. Resumed assistants whose synthetic user parent predates the second tab's cursor are attached to the latest hydrated user turn, eliminating orphans. Retry survives `busy`→`assistant.message.start`→`error`→`retry` transitions correctly; added regression coverage for alias fix and orphan prevention (`event-reducer`, `suspend-live-tail-records`).

## [0.3.0] - 2026-08-21

This release ships per-message branching, rebuilds Providers, Skills, and
Snippets around a unified grid and detail pattern, and makes tunneling and
settings honest about what PiChamber actually supports.

- **Per-message revert and fork with timeline.** Any user message can be
  reverted or forked from its own action menu. Reverted messages are tracked
  per-message with a dedicated dock and a `TimelineDialog` showing the full
  branch. Forking creates a durable server-side branch (real Git branch) with
  a forked title, and navigation intent keeps blank/draft routing predictable.
  Server work lives in `session-daemon` and `protocol`, with
  `revert-navigation-store`, `pi-session-store`, and `session-ui-store`
  owning the client state.
- **Providers catalog rebuilt.** List + sidebar is now grid `ProviderCard`s
  with auth-first sort, search, refresh, and a detail drill-down. Per-model
  default variant is set inline, catalog refresh and connected-state handling
  are fixed, and Settings polish removes stale polling. `ProvidersSidebar` is
  removed.
- **Skills catalog rebuilt.** Grid `SkillCard`s with project-first sort,
  markdown detail view, pill left-aligned and `id` hidden, and markdown
  loading for content. Mobile `/skill` now works: case-insensitive hint
  matching, warm catalog load, and touch-friendly autocomplete. `SkillsSidebar`
  is removed.
- **Snippets rebuilt.** Grid `SnippetCard`s with browse + full-page
  `SnippetMarkdownEditor`, consolidated to a single kind (the kind selector is
  gone), and the trigger is rewired from `/` to `#` with direct content
  expansion. Mobile `SkillAutocomplete`/`SnippetAutocomplete` and
  `ThinkingLevelControl` touch handling are fixed.
- **Settings cleanup.** Utility prompts are renamed/hidden, tunnel provider is
  renamed and hidden to match the Cloudflare-only reality, Behavior and Skills
  now edit markdown, usage reporting is removed, mobile headers are deduped,
  settings padding and `SettingsPageLayout` are fixed, and PiChamber visual
  and defaults panes are tuned. Mobile Settings adds a Remote Servers card and
  sidebar cleanup; desktop context chart on the rail gets a mobile-style hover
  with git changed-files count interpolation (`ContextProgressIcon`,
  `ContextUsageDisplay`).
- **Tunnels: Cloudflare only (breaking).** `ngrok` is removed entirely:
  `ngrok-tunnel.js`, tests, provider, types, `package-manager` helpers, and
  `cli-tunnel-capabilities` ngrok paths are deleted. `TunnelSettings`,
  `DOCS/references`, and research notes now document Cloudflare as the sole
  provider. If you relied on `ngrok`, reconfigure to Cloudflare (`cloudflared`)
  before upgrading.
- **Desktop and rail polish.** Context rail tooltip interpolates live git
  changed-file counts, header/titlebar controls are aligned (collapsed-sidebar
  toggle matches row-mates, spacer fixes), and prompt navigator rail count is
  corrected.
- **Mobile and drawer reliability.** Directory explorer no longer auto-focuses
  on mobile (prevents keyboard pop), drawer swipe can close from anywhere with
  shared `gestureMath` fixes, thinking slider stays interactive while
  dragging, and `ChatInput`/`ComposerEditor` focus handling is tightened.
- **Session drafts that stay put.** New-session drafts are preserved across
  folder changes and runtime switches, blank draft navigation intent is
  documented and tested (`session-intent`), and `ArchiveView`/`SidebarHeader`
  routing handles drafts consistently.
- **Pi provider resilience.** Session daemon now handles the Pi SDK provider
  retry lifecycle correctly so transient provider errors no longer stick
  sessions in failed state, with daemon tests and `pi-sdk-provider-error-handling`
  research note.
- **Docs and housekeeping.** README previews and “why PiChamber” refreshed,
  `pi-revert-support` and `external-tunnel-support` research added, lint
  (`prefer-const`, `require-imports`, `exhaustive-deps`) cleaned, and patch
  releases bundled for provider/skill/snippet polish.

## [0.2.2] - 2026-08-20

This release polishes mobile and tablet interaction, smooths drawer and
sidebar motion, and removes a few nagging UI leftovers.

- Mobile drawers now open from edge swipes and close reliably with
  velocity-aware gestures; accidental opens while scrolling are suppressed.
  Shared gesture math and drawer surface handling are extracted and covered
  by unit tests.
- Tablet header now toggles workspace tabs directly (Changes / Files /
  Terminal / Notes) on the right, with tap-to-close on the active tab.
  Collapsed-sidebar overlap is fixed with header spacers, and the
  context-usage ring is visible like on phones.
- Tablet composer now matches desktop detail: full model/branch/project
  names (no 20/26-char truncation), full pending-changes and task text, and
  desktop draft selectors/sheets.
- Performance: titlebar no longer flushes layout on sidebar toggle, and
  drawer and tablet sidebar interactions are throttled for smoother frames.
- Phone composer truncates long model/project (20 chars) and branch
  (26 chars) labels to keep the input readable, condenses the pending-changes
  pill to icon + diff on mobile, and makes the thinking-level slider
  draggable on touch without selecting nearby text.
- Mobile workspace drawer is now fullscreen with an explicit close button
  in the header.
- Session menus, the header session menu, and the bulk action bar no longer
  show Share or Move to folder.
- Adding a folder no longer auto-pops on launch or instance/runtime switch;
  the directory dialog opens only from explicit user action (sidebar,
  command palette, settings) and dismisses when the runtime changes.
- Android adds a debug variant (`com.pichamber.app.debug`,
  "PiChamber - Debug" with `-debug` version suffix) that can be installed
  side-by-side with the release build for development.

## [0.2.1] - 2026-08-19

This release restores responsive, complete chat rendering while making session
startup and reconnect behavior more reliable.

- Tool cards are no longer hidden after dense turns. Interrupted persisted tool
  calls render as explicit errors, while genuinely active calls remain running.
- Reopening or switching sessions coalesces overlapping open and hydrate work,
  preserves authoritative in-flight tool state, and avoids transient runtime
  conflicts being reported as a disconnected server.
- The Pi session daemon warms after HTTP starts listening, and concurrent
  settings and Git branch loads now share one request.
- Closed timelines, hidden diff panels, and collapsed historical Task tools no
  longer hydrate or subscribe to session data they cannot display.
- Update polling waits for session bootstrap, and Strict Mode remounts continue
  to share the existing event-stream owner.
- Production streaming profiling now drives the authenticated browser API,
  supports Windows-hosted Chrome profiling a WSL server, and validates
  virtualized histories through visible character growth.

## [0.2.0] - 2026-08-19

This release makes the server install path honest: you install and upgrade
`@pi-chamber/web` through the package manager that owns it. It also fixes
session titles, sidebar motion, and a few desktop and tablet layout bugs.

- Server install is package-manager only. The curl `scripts/install.sh`
  wrapper is gone. Docs recommend `bun add -g @pi-chamber/web`, with npm,
  pnpm, and yarn examples.
- `pichamber update` upgrades only the global install that owns the running
  CLI, and restarts a Linux user systemd unit instead of spawning a second
  server on the same port. Startup help documents `--lan`, `--port`, and
  `--ui-password`.
- Remote sessions keep the title Pi already stored, instead of falling back
  to a generated label after reconnect or catalog refresh.
- The Electron window menu stays usable while the sessions sidebar is open.
- Closing the sessions panel now shrinks in lockstep with the header, so the
  title no longer slides the wrong way first.
- Tablets use desktop chrome instead of the phone sheet layout. The composer
  stays pinned in the chat footer.

## [0.1.9] - 2026-08-19

This release improves runtime switching and makes the native mobile client
usable on direct LAN connections.

- Runtime switches now reset host-specific paths, projects, sessions, routes,
  and caches before the authenticated target runtime boots, preventing
  Windows-to-WSL path leakage and stale session requests.
- First session attachment reuses its health and session-list results, while
  background catalog work waits until the focused chat is ready.
- Native Capacitor clients use authenticated `EventSource` for direct LAN Pi
  event streams instead of the buffered HTTP adapter.
- Mobile Instances can export a bounded, redacted diagnostics log for stream,
  connection, health, and send failures.
- Mobile sidebar project rows are tighter, and the global mobile overflow rule
  no longer turns clipped UI elements into nested scroll containers.

## [0.1.8] - 2026-08-18

This release publishes the PiChamber server/CLI to npm as `@pi-chamber/web`.

- Install with `npm install -g @pi-chamber/web` or the existing curl installer. The command is still `pichamber`.
- `pichamber update` and desktop SSH-managed installs use that package. npm `latest` is trusted only when the registry repository is RyderAsKing/PiChamber.
- Desktop installers stay on GitHub Releases. npm publish is opt-in on the Release workflow (`publish_npm` plus the `NPM_TOKEN` secret).

## [0.1.7] - 2026-08-18

This release lets phones reach a desktop on the same Wi-Fi, keeps streaming
cheap on long chats, and cleans up chat and session chrome.

- Android phones on the same network as a PiChamber desktop can connect:
  pairing advertises the real LAN address, packaged app origins are allowed
  for CORS, and launcher/splash art uses the PiChamber mark.
- Live replies no longer rebuild the whole transcript on every token. Folded
  history uses **Load older history** and **Load all history** instead of a
  picker.
- Non-working message actions are gone. Session rename and history navigation
  stay put when older turns appear.
- Changes covers Pi-native last-turn edits and Git branch diffs. Embedded
  quick-chat loads against the panel's project instead of guessing.
- Native app menus on Windows and Linux open from the title-bar control.

## [0.1.6] - 2026-08-18

This release updates the dedicated mobile UI and enables Android APK builds
on version-tag releases.

- Dedicated mobile gets a sessions drawer, workspace drawer, full stacked
  composer, and folder-style project list with working Add folder.
- Tapping a project folder keeps the sessions drawer open while that folder's
  session loads, so another session can still be chosen. Tapping Settings
  closes the drawer.
- Files browsing uses full-width rows and an Up one level control. Sidebar
  type and icons are denser.
- Tagged GitHub releases now build and upload a signed Android APK (and AAB)
  instead of skipping mobile artifacts by default.

## [0.1.5] - 2026-08-18

This release keeps long chats cheaper to keep on screen, and makes adding a
folder a single, obvious action.

- Long sessions stay smoother by reusing settled transcript records, showing
  compact rows for older turns, and stubbing large tool bodies until you
  expand them. Scrolling to a folded message restores the full turn.
- Settings → General → Diagnostics can turn on a this-browser-only Performance
  overlay for frame time, long tasks, and existing render counters. It stays
  off by default and does not sync to other devices.
- Adding a folder is driven by the path field: Browse picks a location without
  adding it, and **Add folder** is the only primary action. Clone lives in the
  directory list header. Already-added folders stay openable so a nested folder
  can still be added. On Windows, Browse uses the modern folder picker.

## [0.1.4] - 2026-08-18

This release keeps long chats readable while they stream, and restores session
history that could vanish after a few turns.

- Older session history no longer disappears after sending a message once a
  chat is long enough to virtualize. The transcript stays on screen, and
  switching sessions still uses the existing cache.
- Streaming replies stay smoother: token updates are batched per frame,
  settled markdown is left alone, and live prose wraps at the full chat
  width instead of a narrow strip.
- Thinking traces collapse when the answer or a tool starts, stay cheap
  while they stream, and can be collapsed by default. Those reasoning
  preferences now persist across reloads.
- Settings layout and project spacing are tighter, and About PiChamber is
  available from the app.

## [0.1.3] - 2026-08-18

This release makes everyday PiChamber use feel calmer and more predictable: the
composer takes up less space, model choices are easier to understand, and
returning to an older chat keeps using the model that chat was built with.

- The composer now uses a cleaner stacked layout with the model and thinking
  controls kept together, while removing the unused desktop focus-mode control.
- Thinking is now presented as a larger, discrete slider with clear minimum and
  maximum labels. The available levels follow the selected Pi model.
- New-session thinking defaults can be saved per model, so different providers
  can keep their own preferred level.
- Reopening an existing chat restores its most recently used model and thinking
  level instead of inheriting whichever model was selected most recently
  elsewhere. You can still change either choice manually.
- Model pickers now use the configured-provider catalog and can hide models
  that should not appear in everyday selection lists.
- Project settings use the shared model picker, with a more consistent layout
  for choosing a project's default model.
- Session and project navigation is quieter and more compact, with cleaner
  sidebar spacing, simpler session rows, and a unified Git/Changes rail.
- Live conversations stream more smoothly, with less duplicate text while
  responses arrive and better preservation of the active chat during switches.
- Incomplete project actions no longer trigger premature validation errors while
  they are still being filled in.

## [0.1.2] - 2026-08-17

Desktop 0.1.2 is a Windows-focused reliability cut. Packaged Electron should get past Loading, show models, and talk to the Pi session daemon on native Windows.

- First launch with no project selected marks the Pi session cluster `ready` with an empty folder focus instead of staying on Loading.
- A leftover empty or unreadable Pi daemon lock is retried and stolen instead of failing `/api/pi/*` with `DAEMON_LOCK_UNAVAILABLE`.
- Built-in providers that are not in `models.json` return `config: null` instead of HTTP 400, so Settings/Providers no longer fail on amazon-bedrock, openrouter, or opencode-go.
- Model pickers (including Small Model) list every catalog provider that has models, including unauthenticated ones, so you can browse before login. The leftover `/api/small-model` call is gone.
- Windows Pi session directories match the Pi SDK cwd encoding, including drive letters and Git Bash/MSYS/Cygwin/WSL `/c/...` paths, so PiChamber and the Pi CLI share the same JSONL sessions.
- The private daemon listens and connects over a Windows named pipe with IPC `path` options. Sidecar `chmod` failures on Windows no longer prevent the daemon from recording ready/failure state.
- Unpackaged `electron:dev` pins a real semver onto `app.setVersion` before `electron-updater` constructs, so host Electron version `0.0` no longer crashes the desktop shell.

## [0.1.1] - 2026-08-17

- Desktop and web packaged icons now use the PiChamber hexagon-and-pi mark instead of the inherited OpenChamber cube.
- Packaged Electron no longer blocks filesystem fetches from `pichamber-ui://app` (CORS now allows the workspace directory header), and the Pi session daemon is spawned as Node so Windows desktop no longer sticks on Loading with `/api/pi/*` 400s.

## [0.1.0] - 2026-08-17

First public **PiChamber** release. This cut ships **Electron desktop** only (macOS, Windows, Linux AppImage). The npm CLI package and native mobile apps are not published yet.

### Why this exists

PiChamber is a community fork of [OpenChamber](https://github.com/openchamber/openchamber). OpenChamber proved that a coding-agent workspace can live on the desktop, in the browser, and on a machine you reach from anywhere. The product direction here is different: **a GUI and remote-hosting surface for [Pi Coding Agent](https://pi.dev)**, not another OpenCode wrapper.

People love Pi because it stays small. The agent, the session files, the skills, the prompts, and the config all belong to Pi. The missing piece was a serious remote UI: something that feels like OpenChamber, but talks to Pi, so you can run and supervise that same agent from your desk or from another device.

That is the whole bet. Keep Pi's minimalism. Add the "use it from anywhere" layer OpenChamber already solved well. Do not drag OpenCode's runtime, catalog, or product vocabulary along for the ride.

Desktop starts the PiChamber backend **in-process** and runs a **Pi-native session daemon**. There is no sidecar OpenCode binary and no separately installed Pi CLI required for the app to work. Sessions, models, providers, skills, prompt templates, and `AGENTS.md` are Pi's. Pairing, auth, Git, files, terminal, and the shell around them are PiChamber's.

### What comes next

A later release will add an **extensions GUI** that follows Pi's own extension model, instead of inventing a second plugin system. Native extensions stay off in this build until that security and UI contract exists.

### The UI was rebuilt

The first Pi cutover unmounted the OpenChamber workspace and briefly shipped a stripped prototype. This release puts a **full workspace back on Pi**: session sidebar, composer, settings, files, Git, terminal, and the context rail, all talking to `/api/pi/*` instead of OpenCode.

That was not a reskin. Session truth moved to a Pi session store and a live session catalog. The sidebar, streaming chat, loaders, deep links, and default theme were redone around that catalog. Git and Changes sit on one rail. Streaming no longer stutters duplicate characters or paints the wrong transcript on switch. The default look is a new PiChamber theme; startup uses a shimmer loader instead of a dead chrome flash.

### What was removed

These OpenCode-era product surfaces are gone on purpose. They depended on a runtime Pi does not have, or they fought Pi's own resource model:

- OpenCode as a managed process, bundled CLI, generic API proxy, SDK in the browser, and all `/api/opencode/*` upgrade/health routes
- VS Code extension host (`packages/vscode`)
- Goal Mode, Plan Mode, pinned/reinjected context, session assist, auto-review, and multi-run/fusion
- Managed worktrees as an OpenCode-owned feature
- Scheduled tasks and `.agents/loops` scheduling (UI, server, CLI, and Electron shutdown checks)
- Agent/session-control CLI commands (`session`, `schedule`, and other OpenCode control paths)
- OpenCode skill-catalog installer and Git/ZIP skill copy-into-project flow
- OpenCode prompt optimizer and response-style settings
- Voice, dictation, and TTS (local and cloud)
- Quota / usage dashboard tied to the old runtime
- MCP, agents, commands, and plugins settings pages (hidden and unwired; not a Pi surface yet)
- Separate OpenCode in-app upgrade toasts, routes, and binary upgrade capability
- Event realtime-proxy path, and unused tunnel/relay host orchestration that was never wired into the Pi daemon server
- Floating work-status sidebar and "recent activity" sidebar section
- Split Git/Changes toggle and the unused PR surface in the context rail
- Non-English UI locales (de, fr, ja, ko, pl, pt-BR, uk, es, zh-CN, zh-TW) and the language picker; the app is English-only for this cut
- Localized docs that would have described the old OpenCode product incorrectly

OpenChamber settings, sessions, and `~/.config/openchamber` are **not migrated**. Pi owns `~/.pi/agent/`. PiChamber-owned files live under `~/.config/pichamber`.

### How it was optimized

The port was used to make the app smaller and the live path cheaper, not only to swap the agent:

- About **50k lines** of dead code, unused exports, and orphan modules removed after the runtime cutover
- Production UI no longer ships an OpenCode SDK chunk
- i18n collapsed to a single English locale instead of shipping eleven locale bundles
- Live **session catalog** owns sidebar membership and status per directory, with bounded in-flight refreshes, so project/worktree switches do not reload from cold global state
- Topic-isolated session notifiers so chat, sidebar, and other subscribers do not share one coarse store ping
- Streaming markdown chunking and turn-timing without overlapping delta stutter
- Daemon recovery from a dead assistant stream without sticking the session; directory event streams no longer rewind on reconnect
- React Compiler babel pass is opt-in (it was costing a large share of production UI build time)
- Workspace builds run in parallel with a cached UI type-check
- Attachments are temp-path files for Pi tools instead of inline base64 that bloated context
- URL-token auth narrowed to the Pi event stream; other routes stay on the bearer boundary
- Headless `pichamber update` installs before restart and refuses unsafe in-container replacement; Electron still owns its own updater; there is no third OpenCode-upgrade channel

### This desktop cut

Identifiers are PiChamber (`PICHAMBER_*`, `pichamber-ui://`, `/api/pichamber/*`, `/api/pi/*`) with no OpenChamber aliases. MIT attribution to OpenChamber stays. Historical changelog entries below `1.18.1` are the inherited OpenChamber record, not claims about this Pi build.

## [1.18.1] - 2026-08-04

- **Providers:** signing in to an OAuth-only provider now actually completes — the browser login is stored and the provider list updates instead of remaining signed out. OAuth-only providers show a Connect flow instead of an API key form, and their models stay hidden until you are signed in.
- **Sessions:** archived sessions can now be restored to the active list — from the sidebar context menu, the archived-sessions page, or the bulk-selection bar — instead of only offering permanent deletion (thanks to @makeittech).
- Walkthrough: models without a working provider login no longer appear in the walkthrough picker, and Generate stays disabled until a usable model is selected instead of failing with a raw provider error.
- Providers: sign-ins that need extra details (such as GitHub Copilot Enterprise) now ask for them before opening the browser, and device codes come with a working copy button.
- Walkthrough: connecting to a server older than the app now says the server needs updating instead of showing a raw HTML parsing error, and the "Critical" tag is now "Key change" with a tooltip so it no longer reads as a problem found in your code.
- Chat: Ctrl/Cmd+L now adds the selected text to the chat input, or focuses it when nothing is selected; the toggle-sidebar shortcut moved to Ctrl/Cmd+Alt+L.
- Chat: a manually chosen model now stays selected after a delegated subtask finishes, instead of reverting to the agent's default model.
- Agents/CLI: sending a prompt that never reaches its session is now reported as failed, and an unavailable model, agent, or variant is rejected with a clear error before anything is created.
- Desktop/Linux: "Open in Terminal" no longer launches a non-terminal app that is set as the terminal launcher (thanks to @kydorn).

## [1.18.0] - 2026-08-04

- **Walkthrough:** a new guided walkthrough reorders a diff into a sequence of stops — the model groups related changes, explains what each one does, and orders them so each builds on the last. Start one from the Changes and pull-request views for uncommitted work, a branch against its base, or a pull request; nothing runs on its own. Walkthroughs are written in your interface language by default, and the panel can generate one in any other supported language.
- **Mobile/Tablet:** reworked the tablet and foldable layout around the phone's navigation — a persistent resizable sessions sidebar on the left, the workspace (Changes, Files, Terminal, Notes, MCP) as a resizable right sidebar, and app pages like settings and instances shown as centered dialogs. An open diff, edited file, or attached terminal now survives rotation.
- **Providers:** custom OpenAI-compatible providers can now be added and edited from Settings, including their endpoint, models, credentials, headers, and configuration scope (thanks to @makeittech).
- Performance: fixed Bun dependency chunking so the web app no longer downloads a single 18.5 MB vendor bundle at startup; heavy syntax highlighting, screenshot, diagram, editor, and image-conversion libraries now load only when needed (thanks to @makeittech).
- Performance: expanding projects with many worktrees no longer repeatedly reloads their session data.
- UI/Localization: added German interface translations and German documentation (thanks to @SGD-DEV).
- Mobile/Android: pairing QR codes can now be scanned on devices without Google Play Services; the camera closes as soon as a code is recognized, followed by a connection-in-progress screen.
- Mobile/Android: left and right drawer swipes can now start farther from the screen edge, outside Android's system Back gesture area.
- Sessions: launching OpenChamber from a directory other than your project (for example your home folder) no longer produces repeated "not a git repository" errors that could stop sessions and projects from loading (thanks to @makeittech).
- Sidebar: a worktree shared by more than one project no longer appears twice (thanks to @makeittech).
- Sidebar: session titles no longer clip at the ends of their rows.
- Git/Diff: opening a changed file now jumps its header directly to the top, and live updates refresh only files that actually changed while preserving the current review position. Saves from the built-in file editor update the diff too.
- Terminal: opening a terminal no longer waits for the terminal view to finish loading, and startup output is retained if it arrives before the view appears (thanks to @makeittech).
- Chat/Tools: Bash output now applies terminal control characters and strips ANSI formatting, preventing progress output and rewritten lines from appearing as raw escape sequences (thanks to @catan271).
- Chat: queued messages now retry after a temporary send failure or an interrupted turn instead of remaining stuck until another session update.
- Chat: prompts sent through the private relay no longer produce duplicate replies when the connection drops after OpenCode accepted the message, and a queued message already being sent is no longer included in another send.
- Settings/Skills: repository-local `.agents/skills` now appear for the active project (thanks to @makeittech).
- Settings/Skills: renaming a skill now preserves its instructions and supporting files; only skills in locations OpenChamber can safely rename show the action (thanks to @makeittech).
- Sessions: sessions in a newly created worktree now appear without restarting or refreshing the app.
- Agents/CLI: creating a session in a new worktree no longer reports a timeout while the worktree continues to be created in the background.
- Sessions: archiving and unarchiving now stays scoped to the current instance and workspace (thanks to @alexandrereyes).
- Usage: added DeepSeek quota tracking (thanks to @airtaxi).
- Usage: Kimi for Coding now calculates usage correctly when the provider reports either used or remaining quota (thanks to @makeittech).
- Desktop/Linux: terminals and OpenCode now start with the correct shell arguments in AppImage installs, fixing broken zsh startup (thanks to @makeittech).
- Files: browser clients now label file exports as downloads and no longer show the desktop-only reveal action (thanks to @makeittech).
- Chat: assistant messages no longer render active HTML.

## [1.17.2] - 2026-08-01

- **Mobile:** rebuilt the app navigation around two swipe drawers — a sessions drawer (left) with a cross-project tree, swipe actions to rename, archive, or delete sessions, and a workspace drawer (right) with Changes, Files, Terminal, Notes, and MCP tabs. Tapping the session title in the header switches recents from a compact overlay with live status indicators. Cold launches reopen the last active session and land on an explicit connect screen on failure instead of flashing an empty draft.
- **Desktop/Windows:** added Windows ARM64 support (thanks to @airtaxi).
- UI: a new OpenChamber theme (dark and light) is now the default, replacing the previous default theme.
- Desktop: the active session header now has a menu with rename, share, export, archive, delete, and copy-ID actions; share links copy to the clipboard automatically when created.
- Performance: opening the first session after startup is faster — background startup requests no longer queue ahead of the initial message load (thanks to @yulia-ivashko).
- Sessions: a root session can now be moved with all its sub-sessions into a new worktree directly from the header menu.
- Git/Diff: symlinks now appear as link entries in the diff view instead of showing their file content.
- Desktop/Linux: added a Window Controls Style setting to switch between classic rectangular buttons and macOS-style traffic lights (thanks to @kydorn).
- Files: added a global Auto-save setting under Settings → General; binary, PDF, and Office files are excluded from auto-save (thanks to @makeittech).
- Terminal: switching terminal tabs no longer rebuilds the connection from scratch on each open or switch (thanks to @makeittech).
- Sidebar: sessions with active agents now show a live activity indicator even when the sidebar is collapsed (thanks to @pascalandr).
- Usage: all Z.ai usage windows now appear in the usage view.
- Chat: tool descriptions now show the glob pattern when a tool's input uses one.
- Desktop: sticky session headers in the sidebar no longer blink or shift position during page transitions (thanks to @ChangeHow).
- Chat: clicking in the padding area of the composer now correctly places the cursor (thanks to @IbrahimKhan12).
- Chat: the `/` command menu no longer lists a skill twice when a command shares its name (thanks to @IbrahimKhan12).

## [1.17.1] - 2026-07-29

- **Chat tools:** Bash tool cards now show output before a command finishes, keep it in a fixed-height pane, and follow new lines until you scroll away. Long-running commands no longer remain at a 300-second duration, and their timers continue until they finish.
- System prompt optimization: added an optional Behavior setting that reduces OpenCode's built-in system prompt by about 40% for the build and plan agents; it applies after restarting OpenCode and is unsuitable for custom build or plan definitions.
- OpenCode: chats now recover when OpenCode stops responding during a response, and managed OpenCode no longer restarts repeatedly during a temporary connectivity failure.
- Desktop: bundled OpenCode no longer offers a separate update; it updates with OpenChamber (thanks to @yulia-ivashko).
- Chat: fully loaded histories no longer show "Load older" again after a refresh.
- Chat: messages removed by reverting no longer reappear after you send another message.
- Chat: slash-command starters now include text already entered in the draft as command arguments.
- Session goals: goals started from slash commands, including scheduled tasks, now use the command's expanded instructions.
- Usage: OpenAI business-account Codex usage now shows the configured spend limit (thanks to @jrandiny).
- Desktop/Linux: AppImage tray menus now include Show, Hide, and Close, and "Open in" shows system application icons (thanks to @makeittech).
- Settings: subpanels keep a visible vertical scrollbar and no longer show a horizontal scrollbar (thanks to @sergiofspedro).
- Mobile: image previews load when connected through the private relay.

## [1.17.0] - 2026-07-28

- **Context panel:** a new surface rail brings Changes, pull requests, files, terminal, notes, plans, previews, and side chats into one resizable panel. The pull-request surface now shows live checks and comments, and can attach failed checks or comments to a chat draft.
- **Desktop/Linux:** official AppImage releases for x64 and arm64, with in-app updates, frameless window controls, system tray minimize, launch at login, multi-window support, and “Open in” for discovered installed apps. Missing update manifests are treated as “no update” instead of a hard failure, and updater errors surface in About/sidebar (thanks to @BestSithInEU, @jibanez-staticduo, @makeittech).
- **Sidebar:** sessions are organized into Recent and project zones with worktree-grouped or flat views. Scheduled tasks, archived sessions, multi-run, and worktree management now open as full-page views from the sidebar.
- **Agents/CLI:** agents on managed local instances can now create, send to, fork, inspect, and wait for sessions; create isolated worktrees; and manage scheduled tasks through the OpenChamber tool. The CLI adds matching `session`, `schedule`, `projects`, and `models` commands, and a new Schedule a Task starter guides task setup from chat.
- Chat composer: prompts now render Markdown emphasis, attention lines, file and agent mentions, slash commands, snippets, attachment citations, and `~path` references directly while you type. File mentions can be edited in place, and the mobile composer grows with its content instead of using a separate fullscreen gesture.
- Desktop/Linux: fixed an intermittent freeze or crash while chats were streaming with the system tray enabled (thanks to @kydorn).
- Small Model: GitHub Copilot models now use their supported API, fixing summaries, goal audits, commit messages, and other Small Model actions for models that do not support Chat Completions (thanks to @jakoss).
- Chat: selecting text from Markdown code blocks now preserves the code fences, language, and surrounding block structure when adding it to the composer or starting a new session (thanks to @ChangeHow).
- Chat: code blocks no longer shift line layout or merge adjacent text while rendering, and copied code keeps its original text (thanks to @ChangeHow).
- Chat/Permissions: sending a message while a permission prompt is open now denies pending requests in the session and its subagents, then queues the message for the next turn (thanks to @tomzx).
- Chat/Subagents: subagent chats can be prompted when direct subagent prompting is enabled, even if the parent session has not loaded.
- Chat: jumping to messages in long conversations now lands on the intended message when earlier rows have not been rendered yet.
- Settings: added an option to hide starter suggestions on the new-session screen.
- Mobile/Android: terminal taps now open the keyboard, text and backspace input work with Android keyboards, and closing a focused terminal no longer leaves the app unresponsive.
- Shortcuts: fixed a regression where double-Escape could be primed when the current session was not active.
- Mobile/iOS: push notifications now use Apple’s production service by default (thanks to @natheihei).
- Mobile/iOS: notifications now work for development builds installed from Xcode — the app detects its Apple push environment and the server delivers each device to the matching endpoint, so dev (sandbox) and TestFlight/App Store (production) installs both receive pushes.
- Usage: added Crof and NeuralWatt quota tracking with subscription kWh, independent key-allowance windows, and credits-balance fallback across the web server and VS Code extension (thanks to @kydorn).

## [1.16.3] - 2026-07-22

- **Chat attachments:** added Office and OpenDocument files (`.docx`, `.pptx`, `.xlsx`, `.odt`, `.odp`, and `.ods`), with readable text and supported embedded images extracted before sending. Attachments also support more source-code formats, notebooks, HAR files with credentials and cookies removed, SVG and Draw.io files, and HEIC/HEIF images; the composer warns when the selected model may ignore an attachment type.
- **Performance:** opening and switching sessions now prioritizes the selected and visible chats in large workspaces. Failed refreshes keep the existing session list, parent sessions no longer disappear when their sub-sessions load first, and session data no longer crosses between instances, projects, or worktrees.
- **Sessions/Worktrees**: idle root sessions can now be moved with their sub-sessions and uncommitted changes into a new worktree. Worktree creation also recovers when an earlier Git operation left the repository locked.
- Desktop: the app can now start directly with a saved remote instance, URL, or pairing link without requiring a local OpenCode installation or local server.
- Scheduled Tasks: tasks can now start with permission auto-accept enabled, and the permission and Run as goal controls use the same compact toggles as the chat composer.
- Chat: assistant turns now show model, agent, thinking level, duration, and time together in the footer, and replies separated by hidden system or subagent prompts display as one continuous turn. The working indicator shows the model actually producing the active response, streaming at the bottom no longer jitters, and new user messages finish their entry animation instead of snapping into place.
- Chat/Tools: attachments returned by plugin and custom tools remain visible after streaming and refreshes, with the same image previews and file chips as chat attachments (thanks to @FrostiDrinks).
- Sidebar: projects now default to manual ordering instead of recent-activity order; explicit sorting choices remain unchanged.
- Desktop/macOS: added a setting to hide the menu bar item.
- Desktop/Windows: SSH remote instances now connect through native Windows OpenSSH without relying on unsupported connection sharing. Password authentication and port forwarding work through hidden background processes, and connection failures now show the underlying SSH error instead of a generic message.
- Mobile/Terminal: opening the terminal in a mobile browser or PWA now focuses its input and opens the keyboard without an extra tap (thanks to @bashrusakh).
- Context Panel: delayed file-open requests no longer switch the panel back to a file after you select another tab.

## [1.16.2] - 2026-07-18

- **Terminal:** rebuilt terminal sessions across the Web, Desktop, and Mobile apps with faster rendering, retained scrollback after reconnecting, shell and login-shell selection, restart and selected-output attachment actions, live theme changes, and more accurate Unicode and full-screen app rendering. Mobile now includes a full-screen terminal workspace with touch scrolling and selection, quick keys, and Ctrl/Alt input.
- **Pinned messages:** pin important user or assistant messages to restore their text to the agent after conversation compaction.
- **Settings:** pages now use a consistent responsive layout, navigation is grouped into OpenChamber, Workspace, OpenCode, and Library sections, and save failures are shown in the page header. Agent tool permissions now distinguish inherited and explicit rules and show session-granted rules separately (thanks to @makeittech).
- Session goals: audits now wait while direct subagents are still active, and goal details show the model used for the latest successful evaluation.
- Chat: if creating a session fails, the new-session draft stays open and restores the submitted prompt instead of discarding it.
- Sessions: new drafts and sessions now stay with the project selected in the sidebar, including workspaces with nested or sibling projects (thanks to @bashrusakh).
- Small Model: provider API keys referenced through environment variables or files now work for summaries, goal audits, and other Small Model features; Gemini 3 Flash models now use their supported thinking setting.
- Mobile/Android: update downloads now select an APK when a release also includes an Android App Bundle.

## [1.16.1] - 2026-07-14

- **Performance:** large session sidebars stay responsive while chats stream, including setups with many projects, worktrees, and sessions. Opening a long chat after an empty or aborted agent turn also no longer repeatedly loads larger portions of its history.
- Chat: an optional Prompt Navigator adds a marker rail beside desktop chats; hover to preview prompts, click to jump between them, or assign a shortcut in Keyboard Shortcuts settings (thanks to @makeittech).
- Chat: shell-mode command cards now update their status and output while the command runs, with syntax highlighting for the command and output.
- Chat/Subagents: task cards now track the correct subagent when several run at once, preventing one subagent's activity or "Open subtask" action from pointing to another session.
- Chat/Subagents: "Open subtask" now works for nested subagents inside the side-panel chat, with a Parent action to return to the previous subagent (thanks to @ameshkov).
- Sessions: temporary project lookup failures no longer remove worktree groups from the sidebar.
- Small Model: custom OpenAI-compatible providers now use the base URL and API key from OpenCode configuration (thanks to @ameshkov).

## [1.16.0] - 2026-07-13

- **Session goals:** arm the new target button in the composer and your next prompt becomes a [goal](https://docs.openchamber.dev/session-goals/) — the session keeps working toward it on its own, with an independent small-model audit checking each finished turn, until the objective is verifiably complete, blocked, or over its optional token budget. The loop runs on the server, so it continues with the app closed and survives restarts. A goal strip above the composer shows progress with pause/resume; goals can also start from the plan-implement dialog, from scheduled tasks ("Run as goal"), or with the new "Craft a Goal" starter and `/craft-goal` command. While a goal runs, per-turn "ready" notifications are replaced by a single notification when it settles.
- **Usage:** OpenCode Go usage tracking is here, and Codex quota windows now show the correct reset times.
- **Remote access:** connecting over the relay got much faster — the app no longer waits for a stale local address to time out before trying the relay (previously up to ~20 seconds on a phone away from home). When your computer gets a new local IP, paired devices now learn the new address over the relay and quietly move back to the local network on their own — no re-pairing. The phone's launch screen shows which device it is connecting to.
- Remote access: running several OpenChamber instances on the same machine no longer makes paired devices land on a random one of them — only one process per machine serves the relay now. This was behind intermittent "Unable to reach server" errors on paired phones.
- Permissions: per-session auto-accept now lives on the server — sessions keep auto-accepting tool calls while the app is closed and after a server restart, subagent sessions inherit the setting, and it can be enabled on a draft before the first message (thanks to @bashrusakh for the draft fix).
- Chat: subagent sessions can now be prompted directly — open a subagent from the context panel and send it follow-up messages (off by default, available in settings).
- Chat: queued messages now send when the session is already idle instead of waiting forever in some cases, pending agent questions stay answerable after a server restart, and session renames no longer flicker back to the old title (thanks to @bashrusakh).
- Files: the file viewer has a markdown preview toggle (thanks to @greghaynes).
- Sidebar: projects can be sorted by different modes with a direction toggle, pinned sessions survive refreshes, and the file tree stays expanded while it refreshes (thanks to @bashrusakh).
- Command palette: projects are included in the fuzzy search alongside sessions and files (thanks to @bashrusakh).
- Settings: chat visual settings are grouped into labeled sections, and a new editor font size setting for the code editor (thanks to @bashrusakh).
- GitHub: PR and issue context now resolves against the source repository in fork workflows (thanks to @bashrusakh).
- Agents: saving agent settings from the UI no longer drops custom YAML frontmatter fields (thanks to @bashrusakh).
- Notifications: session errors and subagent completions now notify reliably across desktop, web, and mobile.
- Editor: "Open in" now recognizes VS Code Insiders.
- Windows: paths no longer mismatch on drive letter casing, which could split one project into duplicates (thanks to @bashrusakh).
- Mobile: the sessions sidebar opens instantly instead of taking many seconds on some devices (thanks to @tomzx).
- Mobile: renaming a saved instance no longer breaks its connection — the stored access token was getting lost on edit.
- Mobile: on Android 15 the app no longer draws under the status bar.
- Security: requests that spoof local host headers to look like same-machine traffic are rejected.

## [1.15.0] - 2026-07-10

- **Remote access:** a new [private relay](https://docs.openchamber.dev/private-relay/) lets you reach your instance from anywhere — no open ports and no third-party tunnel, over an end-to-end-encrypted tunnel. It turns on by itself when you pair a device over it and turns off once no paired device uses it (thanks to @yulia-ivashko).
- **Mobile:** the native iOS and Android apps open for testing — join the [iOS public beta on TestFlight](https://testflight.apple.com/join/5ek6GU1E) or grab the Android APK from the [latest release](https://github.com/openchamber/openchamber/releases/latest). Connect by scanning a QR code from "Add a device" on your server; the app then moves between your local network and the private relay on its own — leaving home carries the open session onto the relay and coming back returns it to Wi-Fi, no re-pairing. Saved instances show a live Connected status with the active transport, iPad gets a split layout with a persistent sessions sidebar and a resizable Changes/Files sidebar, and the app checks for OpenChamber updates itself (Android shows a download toast).
- **Pairing:** a redesigned ["Add a device"](https://docs.openchamber.dev/connect-devices/) dialog asks where you'll use the device — Anywhere (relay with local network preferred at home), Home network only, or This computer only — then shows a large scannable QR code with a copyable link, and closes itself once the device connects. Links are single-use expiring codes redeemed on connect instead of embedding a long-lived token in the QR (thanks to @yulia-ivashko).
- Devices: the "Connect to this server" list now shows each paired device with a live status — Connected · Local network or Relay — and a platform badge (iOS, Android, macOS, Windows, Linux). Re-pairing or re-entering the password on the same device updates its existing entry instead of adding a duplicate.
- Devices: a paired phone or desktop names the connection after the server's hostname; the name typed when creating the link labels the device in the server's list.
- Desktop: saved servers keep every transport their pairing link carried — the app connects directly on your network and falls back to the relay away from it, including when opening a server in a new window and when restoring the connection after a restart.
- Desktop: the header dropdown (instance / usage / MCP) was restyled with cards — usage grouped per provider, hosts showing a colored status line with ping and the active host highlighted, and MCP servers in one card. Host statuses persist between openings instead of flashing "Unknown", and switching to an already-checked host is immediate.
- Desktop: the servers list in Settings shows live per-server reachability, and importing a pairing link is the primary way to add a server.
- Desktop: Windows builds can launch at login and minimize to the system tray (thanks to @achcyano).
- Chat/Tools: every tool call now expands to show its input, result, and errors, including MCP, plugin, and custom tools; Read and Skill stay compact links to their files. JSON results open in a new navigable summary view with linked URLs and expandable nested data, alongside tree and raw JSON views.
- Chat/Tools: expanded file-edit and patch results now include per-file buttons to open the diff or jump to the first changed line in the file editor.
- Chat/Thinking: reasoning parts stay separate and in chronological order instead of merging into one block, and collapsed previews no longer show empty trailing HTML comments.
- Projects: each project can now set its own default model (thanks to @makeittech).
- Diff/Chat: added a Last turn mode to the Diff view, and latest-turn changed-file chips in chat now open that snapshot while older turn chips stay read-only.
- Chat: Mermaid diagrams now have zoom controls (thanks to @c-w-xiaohei).
- Chat: code blocks can show line numbers that stay aligned while streaming, and a new Wrap Code Block Lines setting (Settings → Chat) controls long-line wrapping.
- Chat: with Sticky User Header enabled, user messages no longer float over earlier messages in long conversations.
- Chat: if sending a message times out or loses the connection after OpenCode accepted it, the app now keeps the sent message instead of rolling it back as failed.
- Mobile: selecting local files from the composer now attaches the picked files even if the composer switches between compact and expanded layouts while the file picker is open.
- Browser: links clicked inside an embedded browser tab now keep the tab on the navigated page instead of remounting the frame.
- Context Panel: raw message rows now keep token and time columns aligned without showing shortened message IDs.
- UI: closing the right sidebar after resizing no longer leaves stale width constraints behind.
- Server: remote clients with non-ASCII project paths connect again (thanks to @FanFan4204).

## [1.14.1] - 2026-07-07

- Chat: finished agent replies can now show a short recap and a suggested next message, with separate settings for each and a Small Model setting for choosing the utility model used for those helpers.
- Notes/Todos: adding selected chat text to notes now uses the Small Model to summarize it automatically.
- Voice: read-aloud can now use the Small Model to summarize long text before speaking it.
- Git/GitHub: commit message and pull-request generation now use the Small Model from setting instead of sending message to chat.
- Chat: the timeline dialog can now load older messages when the current session history has not all been fetched yet.
- Chat: file references with line ranges like `src/file.ts:10-20` are now clickable in messages (thanks to @Catan).
- Git/Diff: opening a changed file now jumps to the first changed line instead of the start of the diff hunk.
- Mobile: the composer stays focused more reliably when the keyboard opens, and the dictation transcript grows the composer like typed text.
- Mobile: iOS PWA safe areas, keyboard overlays, and app-resume connection checks were tightened up.
- Desktop: password-protected instances opened from desktop or a browser no longer take the mobile-only unlock path.

## [1.14.0] - 2026-07-05

- Voice: voice input was rebuilt around live streaming transcription — the composer mic shows a live transcript with a volume meter and timer while you speak, and a recording can be cancelled, inserted, or inserted and sent; failed transcriptions keep their audio so you can retry or accept the partial text.
- Voice: local speech-to-text works out of the box — models (Parakeet for English and 25 European languages, Whisper for a lighter multilingual option) download on demand from a new picker in Settings → Voice, or any OpenAI-compatible Whisper endpoint can be used instead; a configurable shortcut (mod+alt+v by default) toggles dictation.
- Voice: read-aloud can now use a local Kokoro voice (11 English voices), and long replies start speaking after roughly a sentence instead of waiting for the whole message.
- Voice: the Voice settings page was simplified — a single read-aloud toggle owns the playback options, and a new "Enable voice input" toggle hides the composer mic entirely.
- Mobile: the composer collapses into a compact input bar while the keyboard is closed, with a round new-session button beside it (hidden on the new-session screen); tapping the bar expands it and opens the keyboard, and the mic starts voice input straight from the compact bar.
- Mobile: the model and agent selectors moved into a row above the message text, the attachment menu and the new-session project/branch pickers open as bottom sheets with search, and a drag handle above the composer swipes it into a fullscreen editor — swiping down shrinks it back or dismisses the keyboard.
- Mobile: long conversations now load older history with a button at the top of the chat, which disappears once everything is loaded; loading older messages keeps your scroll position steady on all platforms.
- Mobile: the branch/worktree picker on the new-session screen lists all worktrees right after a cold start, and the GitHub connection status is recognized without re-running the connect flow.
- Mobile: opening the web app in a phone browser against a password-protected instance shows the password unlock page again (regressed in 1.13.9).
- Mobile: returning to the app no longer briefly flickers the session list.
- Mobile: continued polish ahead of the native app release — the chat and composer ride the keyboard in one smooth motion (including in long conversations), bottom sheets enter cleanly while the keyboard dismisses, the text cursor stays in place when the keyboard opens, starter suggestions on the new-session screen step aside while the keyboard is up, and switching instances no longer leaves the previous instance's sessions in the sessions list.
- UI: lists across the app were moved to one virtualization engine, so long lists scroll more consistently.
- Mobile: the slash-command, file/agent, skill, and snippet autocompletes were tuned for touch — they can grow up to the top of the chat area, the keyboard-hint footer and description lines are gone, row icons line up, list scrolling no longer bounces the page behind, and picking a command keeps the keyboard open.
- Mobile: in phone browsers the composer now keeps itself above the keyboard on the new-session screen and in the fullscreen editor, and opening the app shows the logo while it connects instead of flashing an unreachable-server error.
- Chat: the stop button now aborts sessions running in a different project or worktree than the currently open one — previously those aborts silently did nothing.
- Desktop: a local instance with a UI password and LAN access no longer gets stuck on "Auth required" and an unreachable-server screen (the app's client tokens are now reliably recognized as local, including for 0.0.0.0-bound servers).
- Desktop: the app prefers your own OpenCode install again — the bundled CLI is used only when no OpenCode is installed anywhere on the machine.
- Windows: OpenCode installed via npm now launches from paths with spaces (such as C:\Program Files\nodejs), binary paths pasted with surrounding quotes work, and discovery also checks the system-wide npm prefix and Scoop's shims — in the web/desktop app and the VS Code extension.

## [1.13.9] - 2026-07-02

- Mobile: added the native iOS and Android app projects ahead of the mobile app release, with continued polish for saved connections, password unlock, QR-code connection scanning, push notifications, iOS widgets, app resume, and native layout details.
- Desktop: the app can now use a bundled OpenCode CLI, or you can choose your own CLI path in settings.
- Desktop: added a Keep awake setting for the upcoming desktop app release to prevent the computer from sleeping while the app is running.
- Desktop: you can now specify optional custom headers when adding a remote OpenChamber instance to the desktop app, including for Cloudflare Access-style setups; settings and environment variables can still override them, and the bundled CLI can be replaced by setting a direct OpenCode CLI path.
- Desktop: SSH remote instances with a saved UI password now open directly after the tunnel connects instead of showing the unlock screen again.
- Chat: fixed edge cases where late-loading tool content, subagent content, or streaming Thinking blocks could pull the conversation away from the latest message or fight manual scrolling.
- Chat: embedded JSON examples in messages no longer render as generated-result cards.
- Sync: chat state now recovers after idle reconnects instead of leaving sessions stuck in a stale busy state.

## [1.13.8] - 2026-06-29

- Startup: launching the app no longer hangs for around 20 seconds before you can open a session, load a diff, or send a message — GitHub pull request status checks no longer tie up the connection to the server during startup.
- OpenCode: when a separate OpenCode is already running (the TUI, `opencode serve`, or a daemon on the default port 4096), the app now starts its own server instead of attaching to it. This fixes the "OpenChamber could not finish initialization" error and stops the app from opening or closing your separate OpenCode when it starts and quits. Connecting to an external OpenCode now requires setting `OPENCODE_HOST`, `OPENCODE_PORT`, or `OPENCODE_SKIP_START`.
- Chat: a new Follow-up behavior setting (Settings → Chat) controls what happens when you press Enter on a message while the agent is still responding — Steer inserts it into the agent's current turn, or Queue holds it until the turn finishes. Replaces the previous queue-mode toggle (thanks to @bashrusakh).
- Sessions: deleting a worktree group from the sidebar, or permanently deleting an archived session that has subagent sessions, now removes those subagent sessions too instead of leaving them behind (thanks to @bashrusakh).
- Sessions: clicking a session inside a worktree group no longer briefly jumps the selection to the project's first session while the sidebar data catches up (thanks to @bashrusakh).
- Sync: a connected but quiet session (for example an agent running a long tool call) no longer triggers repeated background refreshes every ~15 seconds (thanks to @tomzx).

## [1.13.7] - 2026-06-28

- Chat: with tool calls (such as Bash and Edit) shown expanded by default, scrolling no longer twitches, and slow scrolling no longer jumps past several messages.
- Mobile: in long conversations, older messages now load before you reach the very top, and fast scrolling no longer leaves blank gaps where messages briefly disappear until you scroll back.
- Mobile: the model and agent buttons in the composer are now borderless and cleaner, show the provider logo next to the model name, and shorten long names with an ellipsis; in the model picker the thinking-variant control is plain text with a chevron and each row's controls line up.
- Mobile: interface labels (the model and agent selectors and other small labels) are back to their previous size after 1.13.6 shrank them too much.
- Providers: the Add provider form stays open while provider data refreshes or a model is picked in the background, instead of snapping back to an existing provider.
- CLI: `openchamber update` works again after a missing helper broke the command.

## [1.13.6] - 2026-06-28

- Chat: scrolling in conversations now stays steady while sending, queueing, streaming, switching sessions, and loading older messages.
- Chat: selecting a user-installed skill from the slash command menu now invokes the skill and injects its content, instead of inserting the skill name as plain text.
- Context Panel: chat tabs now use the session title and mark the open chat as seen while you are viewing it.
- Desktop/macOS: the Dock icon can now show a badge count for chats with unseen activity, with a new Appearance setting to turn it off.
- Context Panel: Browser and Preview tabs no longer accumulate duplicate auth tokens in their URLs after reloads or navigation.

## [1.13.5] - 2026-06-27

- CLI: global web installs no longer crash on startup when tunnel commands load ngrok capabilities.
- CLI: `openchamber update` works again, and tunnel start paths no longer fail when using managed-local config prompts, multi-instance port selection, or auto-started servers.
- GitHub/Usage: fork upstream detection and Google quota checks no longer fail because of missing server helpers.

## [1.13.4] - 2026-06-27

- UI/Localization: added Japanese interface translations and Japanese documentation (thanks to @yuchi0531).
- Chat: queued messages can now be reordered by dragging them in the queue (thanks to @makeittech).
- Chat: sending a message now closes an open question prompt instead of leaving stale question UI in the composer (thanks to @tomzx).
- Chat: conversations pinned to the bottom no longer jiggle or double-scroll after sending, and revisiting older sessions snaps to the latest message without a smooth-scroll delay.
- Reviews: the Review changes dialog can now run an automatic review loop, with a chat banner for opening or stopping the linked review sessions.
- Models: the model picker now remembers provider group expansion and custom ordering, and Shift+Delete removes a recent model from recents (thanks to @makeittech).
- Shortcuts: the model-selector shortcut can now be customized (thanks to @makeittech).
- Agents: agent edits against an external OpenCode server no longer show a saved-state update when the save did not succeed (thanks to @makeittech).
- Providers: the add-provider form no longer loses the selected provider during background provider refreshes (thanks to @IbrahimKhan12).
- Worktrees: messages sent to new worktree sessions now wait until the worktree session is ready instead of racing ahead (thanks to @bashrusakh).
- Git: commit and pull-request generation from a draft session now starts from the created chat session instead of a temporary draft (thanks to @bashrusakh).
- CLI: startup and status commands now check the live server port before treating an existing process as the active OpenChamber server.

## [1.13.3] - 2026-06-24

- Chat: selecting a user-installed skill from the slash command menu now invokes the skill instead of inserting the skill name as plain text (thanks to @IbrahimKhan12).
- Chat: pasted text containing `@` no longer opens file mention autocomplete unexpectedly (thanks to @charpeni).
- Chat: code blocks in user messages now preserve characters like `<` and `->` instead of escaping them inside the code block (thanks to @bashrusakh).
- Chat: switching sessions and loading older messages no longer causes the conversation to jump backward or oscillate around the current scroll position (thanks to @herjarsa).
- Chat: Arrow Up opens prompt history again when the cursor is at the start of the composer.
- Sessions: new sessions now stay attached to the selected project or current workspace directory instead of sometimes appearing under a stale project (thanks to @bashrusakh).
- Sessions: pinned sessions and folder rows no longer disappear from the sidebar after an empty session-list refresh (thanks to @bashrusakh).
- Agents: agent settings now include thinking variant, temperature, and top-p controls, and clearing temperature or top-p now removes the override (thanks to @bashrusakh).
- Settings/Models: per-model visibility and sibling model selections now stay saved after changes (thanks to @attilaszasz).
- Settings/Skills: the skills catalog refreshes after catalog settings change (thanks to @gokulkgm).
- Providers: disconnecting a provider from settings now works for the selected provider (thanks to @bashrusakh).
- Git: Git identities can now enable SSH commit signing.
- Git: pushing from the Git view now syncs first, reducing rejected pushes when the branch needs to update.
- Usage: MiniMax M3 and Token Plan usage now handle the provider's latest API response format (thanks to @baruchvitorino).
- Startup: managed OpenCode server processes left behind by a previous crash are cleaned up on the next start.
- CLI: stale server PID files are checked more carefully so unrelated processes are not mistaken for an OpenChamber server.
- Files: downloads and file names with non-Latin characters now handle those characters correctly in headers (thanks to @FanFan4204).
- Mobile: subagent chevrons no longer overlap long session titles, and session grouping now matches the exact workspace directory (thanks to @weixiang1862, @lilyzhaun).

## [1.13.2] - 2026-06-18

- Chat/Performance: long conversations and large session lists now stay smooth and responsive while a response is streaming (thanks to @bashrusakh).
- Chat: the end of a streamed response is no longer occasionally cut off — messages now always settle on their complete text (thanks to @IbrahimKhan12).
- Chat: paragraphs in assistant messages now have proper spacing instead of collapsing into a single block (thanks to @foundryseven).
- Files: HTML, image, and PDF previews no longer cycle to "authentication required" every ~50 seconds (thanks to @bashrusakh).
- Startup: the app starts faster by no longer waiting on default OpenCode config, while your manual and per-directory model selections are preserved.

## [1.13.1] - 2026-06-17

- Chat: inline math delimiters no longer incorrectly treat currency amounts like `$50` as LaTeX math expressions — only `$$...$$` display math and `\(...\)` inline math are recognized.
- Chat: pinned welcome starters now appear immediately when a new draft session opens, without needing to open the add dialog.
- Chat: clicking a Mermaid diagram in a chat message now opens a fullscreen pan/zoom preview.
- Chat: code-block highlighting now runs off the main thread, preventing UI freezes when rendering code-heavy responses.
- Chat: the context usage indicator now shows as a circular progress ring with the same color thresholds, visible in all workspace headers.
- Chat/UI: embedded chat views and context panel previews now consistently match the current theme.
- Chat/Mobile: the session status button now responds more reliably to taps on Android.
- Scheduled Tasks: the task editor dialog now supports Cron expressions with inline validation, quick-example chips, and a preview of the next four upcoming runs (thanks to @tomzx).
- Files: syntax highlighting in the file editor, Plan View, and Skills page now uses Shiki for broader language support.
- Agents: deleting a built-in agent no longer creates a disable override — the agent stays as-is and shows a clear explanation instead of silently disappearing.
- Agents: deleting an agent now shows an error toast when the definition is missing, instead of failing silently.
- Startup: providers and agents now load faster by avoiding the full provider catalog on initial load.
- Right Sidebar: switching between sidebar tabs is less likely to re-render unrelated content (thanks to @bashrusakh).
- Sessions: the app no longer crashes on startup when there are many sessions in folders.
- Notifications: desktop notifications no longer show duplicate alerts, and reasoning text is excluded from notification bodies.
- Security: self-hosted instances now include noindex headers and a robots.txt to block search engine crawlers.
- CLI/Installer: the installer now requires Node.js 22 and handles version detection failures with clearer guidance.
- Reliability: session list loading handles Windows paths and concurrent requests more steadily, and duplicate health-check URLs are removed from diagnostics.

## [1.13.0] - 2026-06-15

- Security: LAN and remote browser access now require a UI password before the server will start.
- Desktop: if LAN access was enabled without a password, the app now starts locally and asks for a password before turning LAN access back on.
- Chat: file paths inside fenced code blocks are now clickable, including line and column targets (thanks to @robertoberto).
- Chat: context breakdowns now show message previews and cache hit rates (thanks to @robertoberto, @raz123).
- Chat/Performance: long conversations now use virtualized rendering to keep large histories responsive.
- Chat: custom-answer question textareas resize more steadily while typing (thanks to @bigcoder84).
- Chat/Input: tab-completing a mention no longer changes the selected agent (thanks to @Quat3rnion).
- Chat/Input: Arrow Up moves the cursor inside multi-line drafts again instead of always opening prompt history.
- Chat/Mobile: collapsed tool cards now keep their tool icon visible, and reasoning/tool text no longer clips descenders.
- Files: added dedicated PDF files previews mode.
- Files: added an optional docked files editor toolbar (thanks to @robertoberto).
- Files: file operations now use the active workspace directory more consistently (thanks to @tomzx).
- Sessions: session menus now include a delete action (thanks to @ShogunPanda).
- Sessions: deleting a parent session no longer brings deleted child sessions back into the sidebar (thanks to @panzeyu2013).
- Sessions: switching sessions no longer leaves the chat area blank in some cases (thanks to @panzeyu2013).
- Sessions: selected rows now highlight across the full sidebar gutter.
- Comments: inline file/diff comment drafts now stay in place when focus changes.
- Git/Diff: redesigned the Changes diff view with faster multi-file rendering, expandable hunk separators, a full-file loading toggle, compact responsive controls, and a unified changed/staged context panel workflow.
- Git/Diff: individual diff hunks can now be staged, unstaged, or discarded directly from the Changes view via `git apply`.
- Git/Diff: added a review flow for starting a review from current changes.
- GitHub: GitHub settings can now use credentials from the `gh` CLI when available (thanks to @tomzx).
- Settings/MCP: importing MCP snippets from OpenCode config works again (thanks to @youzini).
- Notifications: notification streams now stay connected more reliably behind proxies (thanks to @kostazol).
- Mobile: the empty Changes view keeps a close control visible (thanks to @lilyzhaun).
- Security: file previews and downloads now reject paths outside the allowed workspace unless access has been granted.
- Sessions: fixed a bug where a running session would briefly flicker as idle (in the sidebar, the send/stop button, and the status row) when the app is protected by a password.
- Desktop: you can now open developer tools from the Help menu.
- Sessions: new draft sessions now start from the default model and agent instead of inheriting the previous session's selection, and fall back to OpenCode's own `default_agent` (and its model) when no OpenChamber default is set.
- Startup: cached settings and session state now appear earlier while the live API finishes connecting.
- Startup: the model and agent now appear faster on the initial draft — config loads under the project key up front (no reload when the draft opens) and the agent list is fetched once instead of per consumer.

## [1.12.4] - 2026-06-11

- Chat: added `/handoff-review` to open a linked review session for the current workspace changes, with actions to send review feedback and implementation replies between the sessions.
- Chat/UI: added a setting to collapse long user messages.
- Chat: `@agent` mentions in rendered messages now use the primary accent color.
- Chat: table copy actions now include a Markdown format option (thanks to @kjhq).
- Chat: Mermaid diagrams can now be opened in a dedicated diagram editor (thanks to @nerdosaurus).
- Models: hidden models now stay hidden in multi-model selection controls (thanks to @kjhq).
- Worktrees: creating a single new worktree session now opens the session immediately while worktree setup continues in the background.
- Multi-Run: creating isolated runs now opens sessions immediately while worktree setup continues in the background.
- Sessions: chat folder assignments now stay in place after reloads.
- Sessions: session, folder, project, and worktree rows now have right-click menus for their available actions.
- Settings: added search across settings pages.
- Settings/Agents: agent prompt and permission edits now stay saved after changes.
- Files: added an editor Vim mode setting (thanks to @Champii).
- Files: writes are now safer when saving through temporary files (thanks to @nerdosaurus).
- Git: changed-file folders now have a revert action (thanks to @kostazol).
- GitHub: issue and pull-request pickers now use server-side search for larger repositories (thanks to @tomzx).
- Preview: inline module scripts are now rewritten in proxied HTML responses, fixing more Vite preview pages (thanks to @mdbetancourt).
- Voice: Plan and file preview markdown now include text-to-speech buttons, with a setting for reading selected text or the full document (thanks to @yangyaofei).
- Desktop/macOS: added a menu bar tray with live session status, Mini Chat access, and a provider usage submenu.
- Desktop/macOS: added an optional vibrancy effect for the left sidebar.
- Desktop/macOS: startup no longer opens unnecessary folder prompts.
- Mobile: refreshed session controls, worktree deletion flow, MCP controls, update flow, and usage tracking for new layout.
- Terminal/Mobile: touch scrolling in the terminal no longer conflicts with terminal input as often (thanks to @kostazol).
- Usage: added Cursor quota tracking.
- UI/Localization: added French interface translations and French documentation (thanks to @pascalandr).

## [1.12.3] - 2026-06-05

- Windows/Startup: WSL OpenCode installs are no longer detected or launched; install OpenCode natively on Windows and configure `opencode.cmd` or `opencode.exe` instead.
- Startup: OpenCode health checks now work with OpenCode 1.15.x.
- Files: file trees now show directory loading errors with a retry action instead of leaving the folder empty, and slow Git ignore checks no longer block directory listings indefinitely.

## [1.12.2] - 2026-06-05

- **Desktop/Windows: the Windows app is now available publicly, with full functionality parity across the app.**
- Tunnels: switching between Cloudflare and ngrok quick tunnels now replaces the active quick tunnel instead of reusing the previous provider.
- Tunnels: ngrok startup failures now show the ngrok or authtoken error returned during startup.
- Projects: the Add Project directory picker now starts with hidden files off each time it opens.
- Chat: prompts sent while creating or switching target sessions now stay attached to the intended project directory.

## [1.12.1] - 2026-06-03

- Chat: completed turns can now show changed-file chips with per-file additions and deletions, controlled by a new Chat setting.
- Chat: LSP tool calls now show the operation, file, and cursor position more clearly, and JSON tool output can be toggled between formatted and raw views or copied.
- Chat: streaming messages now appear correctly after startup, and activity/status rows show for the active session.
- Chat: completed responses no longer lose late-arriving summaries, token counts, errors, structured output, or changed-file details.
- Chat: question cards now show an error or no-longer-pending message when submit or dismiss fails instead of silently doing nothing.
- Chat: the first prompt in a new session no longer gets stuck before sending.
- Chat/UI: sticky user-message headers are now off by default.
- Sessions: session titles update from live session events, and the app now consistently loads all existing OpenCode sessions.
- Sessions: recent sessions now stay visible inside project groups, and new or worktree sessions stay in the correct project/worktree group on desktop, mobile, and VS Code.
- Settings/OpenCode: OpenCode CLI path, update-notification preference, keyboard shortcuts, and protected-session settings now stay saved after changes.
- UI/Time: the 12-hour/24-hour time preference now applies to chat timestamps, usage reset times, scheduled tasks, tunnels, passkeys, Git history, and pull-request dates.
- Settings/Files: the default file preview setting now lives with the Chat appearance settings and applies immediately to open file tabs.
- Preview: embedded previews now rewrite inline module imports, fixing Vite React preview pages that load root-relative modules.
- Desktop: Desktop tunnels now serve the full app UI instead of the headless page.
- Desktop: quitting the Desktop app now stops managed OpenCode processes more reliably, reducing leftover OpenCode processes after exit.
- Desktop: removed the legacy Tauri desktop path; Electron is now the only desktop runtime.

## [1.12.0] - 2026-06-03

- Mobile: added a new mobile UI as the default, with an option in Settings to switch back to the previous layout; this is the foundation for the upcoming mobile app and is available to try now.
- Chat: added customizable draft welcome starters from commands and skills, including guided commands for planning, catch-up, debugging, and exploration.
- Chat: assistant answers now have a dialog for starting a new session from that answer.
- Chat/Input: queued messages no longer auto-send before the active session is ready, and thinking-variant choices are preserved for generated messages.
- Chat/UI: markdown-rendered user messages now preserve line breaks.
- Web/Browser: added a Browser feature for opening websites in the web app and sharing annotations with screenshots to agents.
- Web/Remote Instances: added a headless web app mode, and remote instance switching now changes the OpenChamber API endpoint without loading the full remote UI.
- UI/Themes: added JetBrains Light and JetBrains Dark themes, and VS Code chat colors now map more closely to the active editor theme.

## [1.11.7] - 2026-05-27

- Git: commit history now includes a branch graph and commit-row actions in the history modal (thanks to @ermanhavuc).
- Desktop: added a launch-at-startup setting, and collapsed browser windows now keep their webview state.
- UI/Localization: added Traditional Chinese interface translations (thanks to @Jia35).
- Chat/Input: selecting an agent now switches to that agent's configured model, and malformed tool diffs no longer break chat rendering (thanks to @Adrian-Eckardt).
- Sessions: inline session renaming no longer exits immediately after focus changes (thanks to @youfch).
- Notes/Todos: completed todos stay at the end of the list, and the send-to-session dialog has a cleaner model picker (thanks to @kostazol, @rghamilton3).
- Usage: added a setting to hide prediction rows on usage cards (thanks to @ermanhavuc).

## [1.11.6] - 2026-05-25

- Settings/Plugins: added a Plugins page for managing opencode plugins, with npm update checks and user/project scopes (thanks to @Quat3rnion).
- Tunnels: added Ngrok as a quick tunnel provider in the CLI and Desktop tunnel settings, with readiness checks (requires Ngrok cli and auth).
- Desktop: added optional password setting in OpenChamber sessions settings for the local Desktop server.
- Multi-Run: new multi-run sessions now appear in the session list immediately, and slash-command prompts are sent to the created run sessions correctly.
- Mobile: restored the new-session action in the session sidebar header.

## [1.11.5] - 2026-05-25

- Chat/Input: pending image attachments now show previews, sent image attachments can be cited from assistant messages, and markdown source mode highlights formatting while you type.
- Chat: queued messages now send to the session they were queued from, even if you switch sessions before they are sent.
- Chat/UI: chats keep following the latest response after final task summaries, activity reasoning no longer flashes before settling, and assistant timestamps stay visible on narrow layouts.
- Sessions: session titles can now be renamed inline with a double-click (thanks to @robertoberto).
- Git: changed files are split into staged and unstaged sections, and Git operations work correctly from repository subdirectories (thanks to @ShogunPanda, @kostazol).
- Files: file search now shows the number of matches in the editor panel, and directory rows include a quick-add button (thanks to @attackonryan, @tomzx).
- Settings/Skills: installed skills are discovered more accurately, skill files opened from tool messages now load correctly, and snippet names keep their canonical casing (thanks to @jkker, @isanchez404).
- Mobile/PWA: long-press tooltips work on touch screens, fullscreen panels keep the right header state, deleted or long-named files behave better in file lists, and Android PWA dialogs stay visible (thanks to @kostazol, @lilyzhaun).
- Voice: OpenAI-compatible custom speech providers can now use API keys (thanks to @yangyaofei).

## [1.11.4] - 2026-05-22

- Desktop: Electron is now the desktop release target, with updated macOS menu actions for the right sidebar and terminal dock.
- Chat: added reusable snippets with `#` autocomplete in the composer and a Snippets settings page for global and project snippets with [opencode-snippets](https://github.com/JosXa/opencode-snippets) plugin compatibility.
- Multi-Run: runs can now be split into separate prompt/model groups, and Multi-Run prompts support command, file, agent, and snippet autocomplete (thanks to @tomzx).
- UI: refreshed the desktop workspace shell with a full-width header, framed chat area, and smooth left/right sidebar open and close states.
- Chat: completed reasoning blocks stay collapsed without replaying the collapse animation when you reopen a session.
- Files: file search and mention results avoid mixing entries from similar query/cache keys (thanks to @isanchez404).
- Voice: preview audio now stops and cleans up correctly when you stop playback or leave Voice settings (thanks to @isanchez404).
- UI/Localization: refreshed Simplified Chinese terminology across the interface (thanks to @luojiyin).

## [1.11.3] - 2026-05-19

- Chat: question cards now include copy buttons for Markdown and JSON (thanks to @robertoberto).
- Chat: slash command autocomplete now includes skills and clearer command/type badges.
- Chat: slash, file, skill, and agent autocomplete selection now stays steadier when using the keyboard or mouse.
- Chat: external links in messages now show favicons with better contrast, and skill links render correctly in user message rendered as markdown.
- Chat: multi-file tool diffs now render safely, including files with mixed line endings.
- Sessions: archived session lists handle large archives better, and sub-session expansion is kept separate between Recent and project sections (thanks to @vhqtvn).
- Sessions: deleting or archiving a parent session now shows a descendant count that matches what will actually be removed (thanks to @vhqtvn).
- Git: reverting a chat message now refreshes the Git changes view afterward.
- Updates/PWA: OpenCode update and PWA install prompts can now be dismissed without reappearing repeatedly (thanks to @robertoberto).
- Notifications: browser and VS Code notifications work without duplicate alerts.
- Terminal/Mobile: the terminal viewport now stays above the mobile keyboard more consistently (thanks to @Dav1dch).
- Usage: added Wafer.ai quota tracking and removed the duplicate Zhipu usage provider entry (thanks to @bowber).

## [1.11.2] - 2026-05-18

- Chat: thinking blocks can now be collapsed, and expanding tool details feels smooth (thanks to @ermanhavuc).
- Chat: reverting or forking messages now keeps file attachments in place, with clearer undo/redo controls (thanks to @youfch, @ermanhavuc).
- Notes/Todos: context panel sizes are remembered, and todos can be reordered with drag and drop (thanks to @ermanhavuc).
- Git: commit history can now show file diffs inline (thanks to @ermanhavuc).
- Git: branch history works better for local-only branches, and branch search fields accept typing again (thanks to @ermanhavuc).
- Sessions: root project sessions now show up correctly in the session switcher (thanks to @isanchez404).
- Skills: installed skills now match OpenCode's own skill list more closely.

## [1.11.1] - 2026-05-15

- Multi-Run: added fusion for multi-run sessions.
- Multi-Run: added optional isolation and support for non-Git projects.
- Chat/Sessions: added a header session switcher with project, branch, diff, active, unread, and sub-session context.
- Chat/Subagents: opened subagent sessions read-only in the context panel and made subagent chats read-only.
- Chat/Shortcuts: made the agent-switching shortcut configurable and usable from the chat input/model picker.
- Desktop/Mini Chat: added session switching and the new-session shortcut to Mini Chat, while preserving user-selected sessions during startup.
- Preview: improved embedded preview proxying for absolute same-origin requests and WebSocket URLs, and avoided launching unrelated project actions when no dev-server action is detected.
- Updates/Usage: added a setting to disable OpenCode update notifications, and quota reset times now display in your local timezone.
- Chat/UI: sorted-mode tool paths animate consistently, and tooltip rendering is guarded defensively.
- Git: large change lists now display reliably, and branch selection stays hidden for non-Git draft sessions.
- Settings/Skills: the skills catalog now keeps the selected source label visible when switching sources (thanks to @kjhq).

## [1.11.0] - 2026-05-14

- Updates/OpenCode: added in-app OpenCode update checks and upgrade actions.
- Voice: added local Whisper speech-to-text.
- Voice: synced speech recognition settings across devices and let server transcription finish processing audio when voice input stops (thanks to @kostazol).
- Chat/Permissions: restored `@agent` mentions in sent messages and parent-session auto-accept for child-session permissions.
- Chat/Input: queued messages now auto-send one at a time in FIFO order, and model/agent selections persist across reloads (thanks to @lyxxx708, @chutastic).
- Chat/Performance: virtualized more timeline content, deferred heavy tool output, and improved scroll-to-bottom behavior.
- Git: generalized repository provider handling beyond GitHub and made commit/PR generation more tolerant of JSON wrapped in assistant text.
- Terminal: rejected file paths as terminal working directories, preserved UTF-8 replay chunks, and cleaned up WebSocket/SSE listeners reliably during shutdown and reconnects (thanks to @isanchez404).
- Usage/Reliability: guarded quota percentages and reset timestamps defensively.
- UI/Reliability: added smaller fixes for chunk-load recovery, locale retry behavior, stale attachment reads, scheduled tasks, session folders, and accessible Git/session controls (thanks to @isanchez404).

## [1.10.4] - 2026-05-09

- Desktop/Mini Chat: improved Mini Chat session controls with current context usage in the compact header and a single header action that opens either the active session or current draft in Mini Chat.
- Chat/Input: model, variant, and agent labels collapse better on narrow widths.
- Git/Worktrees: pull-request worktrees can now reuse an existing local branch when it matches the PR head.
- Git: deduplicated lightweight and full status refreshes separately, preventing stale or mismatched Git updates during background polling (thanks to @isanchez404).
- Files: ignored stale file loads, guarded pending navigation, and stopped switching files when save fails.
- Terminal: cleaned up idle WebSocket connections and scoped SSE connection-open handling per retry attempt.
- Settings/UI: improved keyboard and screen-reader support for resizable Settings navigation and collapsible sidebar groups (thanks to @isanchez404).
- Reliability/Sync: preserved message part update ordering (thanks to @isanchez404).

## [1.10.3] - 2026-05-08

- Desktop/Electron: added Mini Chat windows for focused conversations without the full workspace shell, including session/draft handoff back to the main window, always-on-top pinning, and quick access from the header, session list, command palette, and keyboard shortcuts.
- Desktop/Startup: show the splash window earlier while the local runtime starts.
- Chat/Scrolling: rebuilt auto-follow behavior for active responses.
- Chat/Scrolling: saved scroll positions restore consistently after session switches, hydration, and draft-to-session transitions.
- Chat/UI: tightened scroll-to-bottom behavior and code-block scrolling handoff.
- Chat/Input: fixed attachment-only queued sends, stale attachment restores, stale file-search results, autocomplete tab handling, and focusable removal controls (thanks to @isanchez404).
- Reliability/Sync: reduced stale and duplicate live-state updates across request arrays, retry metadata, streaming indicators, and session status events, cutting unnecessary rerenders and stuck activity states during long-running chats (thanks to @isanchez404).
- Files/Skills: ignored stale directory refreshes and outdated skills catalog/repo scans.
- Git/Terminal/Desktop: fixed sandbox database loading in ESM, forwarded lightweight Git status mode across runtimes, preserved Electron SSH desktop hosts when saving instances, and made terminal UTF-8 locale fallbacks platform-aware (thanks to @isanchez404, @liyiopener).
- UI/Reliability: added smaller polish fixes for mobile Settings Escape handling, Multirun model limits, text-selection cleanup, and upstream event-stream cancellation (thanks to @isanchez404).

## [1.10.2] - 2026-05-07

- Projects: added repository cloning to the Add Project flow.
- Chat/Reliability: stabilized live turn rendering and session sync caches.
- Terminal: improved Android tablet keyboard handling, including control-key shortcuts, and kept app shortcuts from stealing focus while typing in the terminal (thanks to @Dav1dch).
- Terminal: set a UTF-8 locale for terminal sessions (thanks to @liyiopener).
- Usage: OpenRouter credit balances now avoid misleading percentage displays and use clearer labels across usage views (thanks to @zerone0x).
- Preview: improved embedded preview proxying with cleaner URL rewriting, fewer false-positive dev-server errors, steady navigation, and theme-aware preview frames.
- Notifications: suppressed inherited subagent completion notifications.

## [1.10.1] - 2026-05-06

- Git: added one-click Sync and stash management, including stash access from a clean worktree.
- Git: improved sync safety and feedback with latest remote refs, clearer progress banners, less flicker during refresh, cleaner header controls, and better unavailable pull-request states.
- UI/Localization: added Polish interface translations, expanding language support for Polish-speaking users (thanks to @levy52).
- Sessions: added a quick archive action directly on session rows (thanks to @zoubenr).
- Files: added a manual save mode to the file editor.
- Chat/Timeline: added full-text timeline search across user, assistant, and tool messages in a session.
- Chat/Reliability: pending questions now survive session switches and directory eviction.
- Mobile/Terminal: added an opt-in keyboard resize mode and steady touch terminal input.
- Terminal: restored focus back to terminal input after Ghostty element blur events.
- Startup/Reliability: configured OpenCode CLI paths are now validated before managed startup, with clearer errors for missing, non-executable, or app-bundle paths.
- Performance/Reliability: reduced duplicate app initialization, deferred heavier views, lowered local server status overhead, optimized markdown file-link detection, reduced sync recovery payloads, and suppressed expected missing-directory noise.

## [1.10.0] - 2026-05-05

- Preview: added an embedded dev-server Preview pane for loopback apps, with authenticated proxying, Vite/HMR support, same-origin API request handling, and safer local dev-server shutdown (thanks to @wpbiggs).
- Preview: added preview console capture, DOM element inspection, annotation context, and Electron screenshot attachments.
- Projects/Terminal: added Auto-discover for local dev servers, background terminal startup, action-linked Preview reopen controls, and cleaner terminal tab styling (thanks to @wpbiggs).
- Settings/Behavior: added a dedicated Behavior page with global `AGENTS.md` configuration and response style presets.
- Chat/UI: added a wide layout option, steady scroll position across sessions and generated prompts, less flicker during streaming, and safer rendering for malformed message parts (thanks to @jwcrystal, @pasta-paul).
- UI/Settings: improved settings scrolling, empty states, and button/overlay polish (thanks to @Yabuku-xD).
- GitHub/Git: improved fork-aware issue and pull-request listing, PR status handling, startup loading feedback, remote MCP headers, and long model ID handling (thanks to @corrm, @ricautomation, @yart).
- Reliability/Streaming: reconnects now recover immediately after OS wake-from-sleep, long agent sessions avoid streaming hangs, concurrent sessions sharing the same provider are throttled more safely, and model metadata refreshes after OpenCode restarts (thanks to @jwcrystal, @pasta-paul, @Yabuku-xD).
- Onboarding/Updates/Mobile: added OpenCode CLI auto-detection during onboarding, cross-checks update prompts against npm, and improved iPad/tablet controls for fewer false update notices and smooth touch use (thanks to @IslamNofl).

## [1.9.10] - 2026-04-28

- UI/Localization: added Korean interface translations and default new installs back to English when no language has been chosen (thanks to @An-jinu).
- Chat/Models: unified the model picker across desktop and mobile with a cleaner selection flow (thanks to @daveotero).
- Projects: improved the project directory picker with expandable pinned folders and better file/path handling.
- Chat/UI: improved split-response action placement, error-message alignment, tab close affordances, and overscroll behavior.
- Sessions/Sidebar: fixed stale session, folder, project, and worktree state after mutations, and polished pinned-session indicators (thanks to @corrm, @Yabuku-xD).
- Reliability/Startup: hardened managed OpenCode startup, preserved shell PATH reliably, ignored stale downgrade update prompts, and improved stream/proxy recovery with heartbeat support.

## [1.9.9] - 2026-04-26

- UI/Localization: added a localization foundation with translated interface strings for Spanish, Brazilian Portuguese, Ukrainian, and Simplified Chinese.
- Settings/Appearance: added selectable interface and code fonts with 10 choices each.
- Chat/Workflow: added keyboard turn navigation, widened chat content, and introduced local workspace review and summarize slash commands.
- Chat/Mobile: improved mention and autocomplete behavior with complete results, clearer active-tab scoping, and less context-switching while drafting prompts.
- Chat/Tasks: todo list progress now updates live as task status changes, and task/model status hints are steady during active runs (thanks to @Yabuku-xD).
- Files/Editor: added an "Open files in preview mode" setting and improved multi-file edit/diff safety (thanks to @daveotero).
- Reliability/Performance: improved cold start and streaming responsiveness with lazy-loaded heavy components, chunk-load recovery, lower re-render churn, and safer reconnect/local-stream recovery (thanks to @Yabuku-xD, @jwcrystal, @vhqtvn).
- Desktop/Web/Mobile: improved Electron update restart behavior, PWA service-worker notifications, mobile keyboard handling, and the Add Project panel flow (thanks to @Jovines, @vhqtvn).

## [1.9.8] - 2026-04-22

- Sessions/Reliability: fixed parent-child session sync during reconnects and navigation (thanks to @jwcrystal).
- Settings/Sync: settings updates now sync reliably across clients, and sidebar session pagination is steady in larger workspaces.
- Sessions/Folders: folder changes now persist through server-backed endpoints.
- Notifications: permission notifications are now suppressed when auto-accept is enabled.
- Chat/Files: improved changed-files handling in chat and restored quick file-open flows from pending changes (thanks to @jwcrystal).
- UI: improved the bottom scroll shadow and hid the tasks row when there is no active work.
- Reliability/Desktop: improved live event-stream recovery after transient stalls, wait briefly before failing chat actions during reconnects, and persist Electron server logs for easier disconnect debugging.
- Desktop/macOS: System color mode now tracks OS theme changes, traffic-light controls stay visible after dock restore, and update restart/changelog handling is more reliable.
- Chat/Commands: added `/summary` slash command for a non-destructive session summary - optional topic hint after the command focuses the output, and the prompt is customizable under Settings: Magic Prompts.

## [1.9.7] - 2026-04-22

- Desktop: added an Electron desktop runtime in parallel with the current Tauri app, with Electron planned to become the default path in an upcoming release.
- Plans/Notes/Todos: added editable project plans from assistant messages, external plan upload, configurable planning magic prompts, and quicker note/todo handoff into new sessions or worktrees.
- Chat/Files: you can now drag files and folders from the file tree into chat, with improved `@folder` autocomplete (thanks to @youfch).
- Sessions/UI: added bulk session selection in the sidebar and fixed pinned sessions (thanks to @yart).
- Files/Git: added a file-change summary bar and auto-refresh for open files changed outside the app.
- Git/Worktrees: improved branch/worktree reliability by allowing checkout with uncommitted changes, tightening worktree cache invalidation, and reducing incorrect remote prefetches (thanks to @jwcrystal, @jasonalsing).
- Settings/MCP: improved MCP auth flow with better remote-config support and clearer diagnostics, and aligned config resolution with OpenCode behavior (thanks to @daveotero, @cyan).
- Reliability/Chat: hardened bootstrap and stream-connection recovery, preserved session/connect state, and reduced streaming UI churn.
- Web/PWA: added install orientation controls and fixed loopback-origin handling for web push notifications in local setups (thanks to @vhqtvn, @yart).

## [1.9.6] - 2026-04-17

- Reliability/Streaming: switched live message events to a WebSocket-first transport with SSE fallback, added response compression, and hardened proxy/compression handling (thanks to @geekifan, @jwcrystal).
- Sessions/Scheduled Tasks: added scheduled task creation and management with locale-aware scheduling.
- Sessions/Worktrees: enforced session worktree isolation and tightened session-switch safety.
- Files: added a full Go to Line workflow (toolbar + shortcut + dialog) and a new Copy Relative Path action (thanks to @coldbrow).
- Files: file trees now auto-refresh when files change outside the app (thanks to @jwcrystal).
- Chat/Export: added export session as Markdown and improved empty-state/export behavior (thanks to @coldbrow).
- Chat/Requests: restored blocking request visibility in sub-sessions, scoped auto-approve to the active session tree, and reduced noisy auto-approved notifications during multi-session work.
- Desktop: added quick open and a LAN access toggle, plus safer quit behavior around scheduled tasks (thanks to @An-jinu).
- Chat/Markdown: added LaTeX rendering support for clearer math and technical notation in messages (thanks to @ricautomation).
- Settings/Skills: skills are now sorted within groups (thanks to @tomzx).

## [1.9.5] - 2026-04-14

- Security/Auth: added passkey sign-in for protected instances and new 1-week/30-day session expiration options (thanks to @daveotero, @pm0u).
- Voice: added OpenAI-compatible custom server support for both text-to-speech and speech-to-text, including configurable TTS model/pitch/volume and stricter custom URL validation for safer setup (thanks to @ablepharus).
- Chat/Tool Output: added an interactive tree viewer for structured outputs and fixed JSON quote rendering (thanks to @yaozhenghangma).
- Chat/Reliability: fixed question-tool content disappearing after refresh and hardened subagent/session recovery paths.
- Sync/Performance: optimized multi-session streaming with per-directory queues, event coalescing, and parts-gap recovery to keep live updates smooth under heavy activity (thanks to @jwcrystal).
- Sessions/UI: kept active sessions visible in Recent, auto-expanded parent groups when opening subagent sessions, and hid empty archived/folder sections (thanks to @jwcrystal).
- Git/UI: restored Git changes panel visibility and sidebar sync (thanks to @jwcrystal).
- Desktop/Startup: delivered a more guided first-launch and smart recovery flow, plus startup and remote-window interaction fixes to reduce early-session friction (thanks to @jwcrystal).
- Usage: added Zhipu AI Coding Plan tracking and restored model-variant compatibility with older OpenCode runtimes (thanks to @cainiao1992, @Chi-square-test).

## [1.9.4] - 2026-04-07

- Settings/Magic Prompts: added a dedicated Magic Prompts page with editable templates for commit/PR generation, PR and issue reviews, failed-check/comment analysis, and merge/cherry-pick conflict resolution.
- Chat/Performance: reduced streaming render churn across the app.
- Chat/Scrolling: fixed jumpy follow behavior and restored stable bottom-resume/live-compaction updates.
- Reliability/Streaming: improved reconnect, retry, and directory-aware event routing to reduce stuck session/subagent states after transient disconnects (thanks to @jwcrystal, @daveotero).
- Chat/Tool Output: LSP diagnostics now render directly in tool output (thanks to @yulia-ivashko).
- Models: added defensive handling for missing model pricing/capability metadata (thanks to @Chi-square-test).
- Desktop/Performance: removed costly window translucency and reduced duplicate notification triggers for a cooler, less noisy desktop experience.
- Startup/Remote: restored remote provider startup behavior and tightened host/port detection to reduce false startup failures.
- Usage: refreshed MiniMax CN coding-plan quota data (thanks to @nzlov).

## [1.9.3] - 2026-03-01

- Security/Chat: user messages now escape raw HTML by default (thanks to @kalac2232).
- Desktop/Performance: reduced Tauri shell CPU/GPU overhead during longer sessions.
- Sessions/Drafts: draft chat config now stays synced with the selected draft target directory.
- Chat/Models: added arrow-key navigation for thinking-mode selection in model controls (thanks to @daveotero).
- Files: added HTML preview support in the file viewer (thanks to @nguyenngothuong).
- Chat: improved error message readability with clearer styling and safer word-wrapping (thanks to @nguyenngothuong).
- Chat/JSON: added an interactive JSON tree viewer with collapse/expand controls and richer color cues for easier inspection of large structured outputs (thanks to @nguyenngothuong).
- Mobile/Settings: fixed lingering settings drawers and removed extra top spacing for a cleaner, less obstructed mobile layout (thanks to @Jovines).
- Git/Worktrees: fixed worktree detection and reset stale integration state when switching contexts.
- Desktop/Settings: window vibrancy now correctly controls macOS window transparency, and settings copy now clarifies when full transparency changes take effect.
- Reliability/Proxy: hardened OpenCode proxy header handling (including identity-encoding normalization, compression-header cleanup, hop-by-hop response-header stripping) and suppressed expected SSE close noise.
- Reliability/Proxy: restored proxied chat event streaming.
- Terminal/Reliability: switched terminal transport to a pure WebSocket path with fallback handling.
- Usage/Providers: added ZhipuAI quota tracking and fixed MiniMax coding-plan and GitHub Copilot overusage calculations (thanks to @kalac2232, @baruchvitorino, @ebrainte).

## [1.9.2] - 2026-03-31

- Chat/Performance: rebuilt live session sync and streaming updates to cut render churn, reduce CPU spikes, and keep long-running chats smooth and more stable across runtimes.
- Worktrees/Multi-Run: added instant draft-first worktree creation and redesigned the multi-run launcher with a cleaner, faster flow for parallel runs.
- Models/Providers: improved custom provider model metadata loading and caching (thanks to @ZeppLu).
- CLI/Server: added `--foreground` for process-manager deployments, made managed server hostname configurable, and added an explicit `--host` option with safer localhost defaults (thanks to @colinmollenhour, @rapidrabbit76, @yulia-ivashko).
- Docker/Deployments: improved container defaults, including UID 1000 user behavior, non-fatal SSH key generation, and better localhost detection in container networking (thanks to @yulia-ivashko).
- Web/PWA: fixed manifest behavior behind Cloudflare Access (thanks to @arthurfiorette).

## [1.9.1] - 2026-03-20

- Sessions/UI: restored Project Notes access in the sidebar, polished notes/todo editing, and fixed project action overlap.
- Chat/GitHub: linked issues and pull requests now appear as user-message attachments and open reliably across runtimes.
- Settings/MCP: adding MCP servers now consistently respects user vs project scope, preventing user-scope entries from being written into project config files.
- Sessions: sidebar lists now keep sessions visible in both Recent and Project sections for easier discovery (thanks to @nguyenngothuong).
- Files: file trees now refresh incrementally after create/rename/delete actions (thanks to @nguyenngothuong).
- Sessions/Worktrees: draft sessions now resolve the correct project when opened from worktree paths (thanks to @yulia-ivashko).
- Desktop: improved stale server-process cleanup on startup and fixed external link opening behavior (thanks to @jwcrystal).
- Usage: added MiniMax Weekly quota provider support (thanks to @nzlov).

## [1.9.0] - 2026-03-20

- UI/Navigation: delivered a major sidebar redesign with clearer hierarchy, unified action patterns, and improved session organization (thanks to @yulia-ivashko).
- Chat: reduced streaming CPU usage and background churn with steady turn rendering, debounced updates, and less storage thrash during long runs.
- Chat: fixed scroll-to-latest and timeline tracking behavior.
- Chat/Permissions: added a session-based permission auto-accept toggle and polished permission-shield visuals for quicker, clearer approval workflows.
- Git: refreshed history visuals and added clearer branch-boundary markers.
- Git: added remote removal from sync workflows and stabilized polling to reduce noisy background refreshes (thanks to @yulia-ivashko).
- Settings/UI: fixed settings scrolling on mobile, made outside-click closing immediate, and reduced settings load churn/CPU spikes.
- Panels/UI: softened panel resize affordances and tightened service dropdown/layout spacing for a cleaner, less distracting workspace.
- Files: added debounced editor auto-save (thanks to @nguyenngothuong).
- Files: reworked search UI for searching in files.
- Reliability/Platform: improved Windows path/process behavior and restored macOS PTY/microphone compatibility.
- Desktop/macOS: lowered the minimum supported macOS version to Ventura (13.0), expanding compatibility on older systems (thanks to @craigharman).
- Updates/Reliability: unified update-check behavior across runtimes.

## [1.8.7] - 2026-03-13

- CLI: fixed a startup regression in global npm/bun installs where wrapper or symlinked `openchamber` entrypoints could exit without output on commands like `--version` or `status`.
- CLI: hardened entrypoint detection across direct, symlinked, and shim-based launches to keep startup behavior consistent across package managers (thanks to @shekohex).
- Windows/Web: daemon startup and Git operations no longer flash extra console windows (thanks to @SergioChan).
- Deployment/Docker: improved `docker run` startup behavior and entrypoint handling (thanks to @nzlov).

## [1.8.6] - 2026-03-13

- Tunnel/CLI: rebuilt tunnel workflows around clearer managed modes and provider-aware lifecycle commands, with safer startup checks, improved diagnostics, and cleaner CLI output for everyday remote access (thanks to @yulia-ivashko).
- Chat: completed a turn-based rendering pipeline that keeps streaming, activity rows, and tool progress more stable in long runs, with smooth auto-follow and fewer jumpy updates.
- Chat/Settings: added richer chat render controls, including sorted/live behavior, compact live Activity previews, and options to keep Bash/Edit outputs open by default.
- Sessions/GitHub: overhauled sidebar session loading and GitHub PR tracking, and added a new minimal sidebar sessions mode on Desktop/Web.
- Sessions: worktrees with active sessions now surface earlier in the sidebar (thanks to @GhostFlying).
- Chat: fixed narrow-layout send behavior for modified Enter shortcuts (thanks to @eengad).
- Chat: fixed queue-button behavior and focus-mode composer sizing.
- Projects/Desktop: project action inputs now submit with Enter, and Desktop settings now include a spell-check toggle for writing comfort (thanks to @DocterZed).
- Mobile/PWA: install metadata now honors orientation lock consistently.

## [1.8.5] - 2026-03-04

- Desktop: startup now opens the app shell much earlier while background services continue loading.
- Desktop/macOS: fixed early title updates that could shift traffic-light window controls on startup.
- Chat: fixed focus-mode composer layout.
- UI/Theming: unified loading logos and startup screens across runtimes, with visuals that better match your active theme.
- Projects/UI: project icons now follow active theme foreground colors consistently.
- Reliability: improved early startup recovery.
- Tunnel/CLI: fixed one-time Cloudflare tunnel connect links in CLI output for `--try-cf-tunnel` (thanks to @plfavreau).
- Mobile/PWA: respected OS rotation lock by removing forced orientation behavior in the web app shell (thanks to @theluckystrike).

## [1.8.4] - 2026-03-04

- Chat: added clickable file-path links in assistant messages (including line targeting) (thanks to @yulia-ivashko).
- Chat: added a new `Changes` tool-output mode that expands edits/patches by default while keeping activity readable (thanks to @iamhenry).
- Chat: in-progress tools now appear immediately and stay live in collapsed activity view (thanks to @nelsonPires5).
- Chat: improved long user-message behavior in sticky mode with bounded height, internal scrolling, and cleaner action hit targets.
- Chat/Files: improved `@` file discovery and mention behavior with project-scoped search and more consistent matching.
- Chat/GitHub: added Attach menu actions to link GitHub issues and PRs directly in any session.
- Chat/Files: restored user image previews/fullscreen navigation and improved text-selection action placement on narrow layouts.
- Shortcuts/Models: added favorite-model cycling shortcuts (thanks to @iamhenry).
- Sessions: added active-project session search in the sidebar, with clearer match behavior and easier clearing during filtering (thanks to @KJdotIO).
- Worktrees/GitHub: streamlined worktree creation with a unified flow for branches, issues, and PR-linked sessions, including cleaner validation and faster branch loading.
- Worktrees/Git: fixed branch/PR source resolution (including slash-named branches and fork PR heads).
- Git: fixed a PR panel refresh loop that could trigger repeated updates and unstable behavior in the PR section (thanks to @yulia-ivashko).
- Files/Desktop: improved `Open In` actions from file views/editors, including app selection behavior and tighter integration for opening focused files (thanks to @yulia-ivashko).
- Mobile/Projects: added long-press project editing with a bottom-sheet panel and drag-to-reorder support (thanks to @Jovines).
- Web/PWA/Android: added improved install UX with pre-install naming and manifest shortcut updates (thanks to @shekohex).
- UI: interactive controls now consistently show pointer cursors.
- Security/Reliability: hardened terminal auth, tightened skill-file path protections, and reduced sensitive request logging exposure for safer day-to-day usage (thanks to @yulia-ivashko).

## [1.8.3] - 2026-03-02

- Chat: added user-message display controls for plain-text rendering and sticky headers.
- Chat/UI: overhauled the context panel with reusable tabs and embedded session chat (_beta_).
- Chat: improved code block presentation with cleaner action alignment, restored horizontal scrolling, and polished themed highlighting across chat messages and tool output (thanks to @nelsonPires5).
- Diff: added quick open-in-editor actions from diff views that jump to the first changed line.
- Git: refined Git sidebar tab behavior and spacing, plus bulk-revert with confirmations for easier cleanup.
- Git: fixed commit staging edge cases by filtering stale deleted paths before staging.
- Git/Worktrees: restored branch rename/edit controls in draft sessions when working in a worktree directory.
- Chat: model picker now supports collapsible provider groups and remembers expanded state between sessions.
- Settings: reorganized chat display settings into a more compact two-column layout.
- Mobile/UI: fixed session-title overflow in compact headers (thanks to @iamhenry).

## [1.8.2] - 2026-03-01

- Updates: hardened the self-update flow with safer release handling and fallback behavior.
- Chat: added a new "Share as image" action (thanks to @Jovines).
- Chat: improved message readability with cleaner tool/reasoning rendering and less noisy activity timing in busy conversations (thanks to @nelsonPires5).
- Desktop/Chat: permission toasts now include session context and a clearer permission preview (thanks to @nelsonPires5).
- Reliability: improved event-stream/session visibility handling when the app is hidden or restored.
- Windows: fixed CLI/runtime path and spawn edge cases to reduce startup and command failures on Windows (thanks to @plfavreau).
- Notifications/Voice: consolidated TTS and summarization service wiring for steady text-to-speech and summary flows (thanks to @nelsonPires5).
- Deployment: fixed Docker build/runtime issues (thanks to @nzlov).

## [1.8.1] - 2026-02-28

- Web/Auth: fixed an issue where non-tunnel browser sessions could incorrectly show a tunnel-only lock screen; normal auth flow now appears unless a tunnel is actually active.

## [1.8.0] - 2026-02-28

- Desktop: added SSH remote instance support with dedicated lifecycle and UX flows (thanks to @shekohex).
- Projects: added project icon customization with upload/remove and automatic favicon discovery from your repository (thanks to @shekohex).
- Projects: added header project actions on Web and Mobile.
- Projects/Desktop: project actions can also open SSH-forwarded URLs.
- Desktop: added dynamic window titles that reflect active project and remote context (thanks to @shekohex).
- Remote Tunnel: added tunnel settings with quick/named modes, secure one-time connect links (with QR), and saved named-tunnel presets/tokens (thanks to @yulia-ivashko).
- UI: expanded sprite-based file and folder icons across Files, Diff, and Git views (thanks to @shekohex).
- UI: added an expandable project rail with project names, a settings toggle, and saved expansion state for easier navigation in multi-project setups (thanks to @nguyenngothuong).
- UI/Files: added file-type icons across file lists, tabs, and diffs (thanks to @shekohex).
- Files: added a read-only highlighted view with a quick toggle back to edit mode (thanks to @shekohex).
- Files: markdown preview now handles frontmatter more cleanly.
- Chat: improved long-session performance with virtualized message rendering, smooth scrolling, and more stable behavior in large histories (thanks to @shekohex).
- Chat: enabled markdown rendering in user messages for clearer formatted prompts and notes (thanks to @haofeng0705).
- Chat: edit tools now use the same diff style as the dedicated Diff view (thanks to @shekohex).
- Chat: pasted absolute paths are now treated as normal messages.
- Chat: fixed queued sends for inactive sessions.
- Chat: upgraded Mermaid rendering with a cleaner diagram view plus quick copy/download actions (thanks to @shekohex).
- Notifications: improved child-session notification detection to reduce missed or misclassified subtask updates (thanks to @Jovines).
- Deployment: added Docker deployment support with safer container defaults and terminal shell fallback (thanks to @nzlov).
- Reliability: improved Windows compatibility across git status checks, OpenCode startup, path normalization, and session merge behavior (thanks to @mmereu).
- Usage: added MiniMax coding-plan quota provider support (thanks to @nzlov).
- Usage: added Ollama Cloud quota provider support (thanks to @iamhenry).

## [1.7.5] - 2026-02-25

- UI: moved projects into a dedicated sidebar rail and tightened the layout.
- Chat: fixed an issue where messages could occasionally duplicate or disappear during active conversations.
- Sessions: reduced session-switching overhead to make chat context changes feel more immediate.
- Reliability/Auth: migrated session auth storage to signed JWTs with a persistent secret.
- Mobile: pending permission prompts now recover after reconnect/resume instead of getting lost mid-run (thanks to @nelsonPires5).
- Mobile/Chat: refined message spacing and removed the top scroll shadow for a cleaner small-screen reading experience (thanks to @Jovines).
- Web: added `OPENCODE_HOST` support (thanks to @colinmollenhour).
- Web/Mobile: fixed in-app update flow in containerized setups.

## [1.7.4] - 2026-02-24

- Settings: redesigned the settings workspace with flatter, more consistent page layouts.
- Settings: improved agents and skills navigation by grouping entries by subfolder for easier management at scale (thanks to @nguyenngothuong).
- Chat: improved streaming smoothness and stability with buffered updates and runtime fixes.
- Chat: added fullscreen Mermaid preview, persisted default thinking variant selection, and hardened file-preview safety checks for a safer, more predictable message experience (thanks to @yulia-ivashko).
- Chat: draft text now persists per session, and the input supports an expanded focus mode for longer prompts (thanks to @nguyenngothuong).
- Sessions: expanded folder management with subfolders, cleaner organization actions, and clearer delete confirmations (thanks to @nguyenngothuong).
- Settings: added an MCP config manager UI to simplify editing and validating MCP server configuration (thanks to @nguyenngothuong).
- Git/PR: moved commit-message and PR-description generation to active-session structured output.
- Chat Activity: improved Structured Output tool rendering with dedicated title/icon, clearer result descriptions, and more reliable detailed expansion defaults.
- Notifications/Voice: moved utility model controls into AI Summarization as a Zen-only Summarization Model setting.
- Mobile: refreshed drawer and session-status layouts (thanks to @Jovines).
- Desktop: improved remote instance URL handling (thanks to @shekohex).
- Files: added C, C++, and Go language support for syntax-aware rendering in code-heavy workflows (thanks to @fomenks).

## [1.7.3] - 2026-02-21

- Settings: added customizable keyboard shortcuts for chat actions, panel toggles, and services (thanks to @nelsonPires5).
- Sessions: added custom folders to group chat sessions, with move/rename/delete flows and persisted collapse state per project (thanks to @nguyenngothuong).
- Notifications: improved agent progress notifications and permission handling to reduce noisy prompts during active runs (thanks to @nguyenngothuong).
- Diff/Plans/Files: restored GitHub-style inline comments (thanks to @nelsonPires5).
- Terminal: restored terminal text copy behavior (thanks to @shekohex).
- UI: unified clipboard copy behavior across Desktop app, Web app, and VS Code extension.
- Reliability: improved startup environment detection by capturing login-shell environment snapshots.
- Reliability: refactored OpenCode config/auth integration into domain modules for steady provider auth and command loading flows (thanks to @nelsonPires5).

## [1.7.2] - 2026-02-20

- Chat: question prompts now guide you to unanswered items before submit.
- Chat: fixed auto-send queue to wait for the active session to be idle before sending.
- Chat: improved streaming activity rendering and session attention indicators.
- UI: added Plan view in the context sidebar panel for quicker access to plan content while you work (thanks to @nelsonPires5).
- Settings: model variant options now refresh correctly in draft/new-session flows, avoiding stale selections.
- Reliability: provider auth failures now show clearer re-auth guidance when tokens expire (thanks to @yulia-ivashko).

## [1.7.1] - 2026-02-18

- Chat: slash commands now follow server command semantics (including multiline arguments).
- Chat: added a shell mode triggered by leading `!`, with inline output visibility/copy.
- Chat: improved delegated-task clarity with richer subtask bubbles, better task-detail rendering, and parent-chat surfacing for child permission/question requests.
- Chat: improved `@` mention autocomplete by prioritizing agents and cleaning up ordering.
- Skills: discovery now uses OpenCode API as the source of truth with safer fallback scanning.
- Skills: upgraded editing/install UX with better code editing, syntax-aware related files, and clearer location targeting across user/project .opencode and .agents scopes.
- Mobile: fixed accidental abort right after tapping Send on touch devices.
- Maintenance: removed deprecated GitHub Actions cloud runtime assets and docs to reduce setup confusion (thanks to @yulia-ivashko).

## [1.7.0] - 2026-02-17

- Chat: improved live streaming with part-delta updates and smarter auto-follow scrolling.
- Chat: Mermaid diagrams now render inline in assistant messages, with quick copy/download actions for easier sharing.
- UI: added a context overview panel with token usage, cost breakdown, and raw message inspection to make session debugging easier.
- Sessions: project icon and color customizations now persist reliably across restarts.
  **- Reliability: managed local OpenCode runtimes now use rotated secure auth and tighter lifecycle control across runtimes.**
- Git/GitHub: improved backend reliability for repository and auth operations (thanks to @nelsonPires5).

## [1.6.9] - 2026-02-16

- **UI: redesigned the workspace shell with a context panel, tabbed sidebars, and quicker navigation across chat, files, and reviews.**
- UI: compact model info in selection (price + capabilities) (thanks to @nelsonPires5).
- Chat: fixed file attachment issues and added exceeded-quota information.
- Diff: improved large diff rendering and interaction performance for smooth reviews on heavy changesets.
- Worktrees: shipped an upstream-first flow across supported runtimes (thanks to @yulia-ivashko).
- Git: improved pull request branch normalization and base/remote resolution to reduce PR setup mismatches (thanks to @gsxdsm).
- Sessions: added a persistent project notes and todos panel (thanks to @gsxdsm).
- Sessions: introduced the ability to pin sessions within your groups for easy access.
- Settings: added a configurable Zen model for commit messages generation and summarization of notifications (thanks to @gsxdsm).
- Usage: added NanoGPT quota support and hardened provider handling (thanks to @nelsonPires5).
- Reliability: startup now auto-detects and safely connects to an existing OpenCode server.
- Desktop: restored desktop window geometry and position (thanks to @yulia-ivashko).
- Mobile: fixes for small-screen editor, terminal, and layout overlap issues (thanks to @gsxdsm, @nelsonPires5).

## [1.6.8] - 2026-02-12

- Chat: added drag-and-drop attachments with inline image previews.
- Sessions: fixed a sidebar issue where draft input could carry over when switching projects.
- Chat: improved quick navigation from the sessions list by adding double-click to jump into chat and auto-focus the draft input; also fixed mobile session return behavior (thanks to @gsxdsm).
- Chat: improved agent/model picking with fuzzy search across names and descriptions.
- Usage: corrected Gemini and Antigravity quota source mapping and labels (thanks to @gsxdsm).
- Usage: when using remaining-quota mode, usage markers now invert direction to better match how remaining capacity is interpreted (thanks to @gsxdsm).
- Desktop: fixed project selection in opened remote instances.
- Desktop: fixed opened remote instances that use HTTP (helpful for instances under tunneling).

## [1.6.7] - 2026-02-10

- Voice: added built-in voice input and read-aloud responses with multiple providers (thanks to @gsxdsm).
- Git: added multi-remote push selection and smarter fork-aware pull request creation to reduce manual branch/remote setup (thanks to @gsxdsm).
- Usage: added usage pace and prediction indicators in the header and settings (thanks to @gsxdsm).
- Diff/Plans: fixed comment draft collisions and improved multi-line comment editing in plan and file workflows (thanks to @nelsonPires5).
- Notifications: stopped firing completion notifications for comment draft edits to reduce noisy alerts during review-heavy sessions (thanks to @nelsonPires5).
- Settings: added confirmation dialogs for destructive delete/reset actions to prevent accidental data loss.
- UI: refreshed header and settings layout, improved host switching, and upgraded the editor for smooth day-to-day navigation and editing.
- Desktop: added multi-window support with a dedicated "New Window" action for parallel work across projects (thanks to @yulia-ivashko).
- Reliability: fixed message loading edge cases, stabilized voice-mode persistence across restarts, and improved update flow behavior across platforms.

## [1.6.6] - 2026-02-9

- Desktop: redesigned the main workspace with a dedicated Git sidebar and bottom terminal dock.
- Desktop: added an `Open In` button to open the current workspace in Finder, Terminal, and supported editors with remembered app preference (thanks to @yulia-ivashko).
- Header: combined Instance, Usage, and MCP into one services menu.
- Git: added push/pull with remote selection, plus in-app rebase/merge flows with improved remote inference and clearer conflict handling (thanks to @gsxdsm).
- Git: reorganized the Git workspace with improved in-app PR workflows.
- Files: improved editing with breadcrumbs, better draft handling, smooth editor interactions, and more reliable directory navigation from file context (thanks to @nelsonPires5).
- Sessions: improved status behavior, faster mobile session switching with running/unread indicators, and clearer worktree labels when branch name differs (thanks to @Jovines, @gsxdsm).
- Notifications: added smarter templates with concise summaries (thanks to @gsxdsm).
- Usage: added per-model quota breakdowns with collapsible groups, and fixed provider dropdown scrolling (thanks to @nelsonPires5, @gsxdsm).
- Terminal: improved input responsiveness with a persistent low-latency transport for steady typing (thanks to @shekohex).
- Mobile: fixed chat input layout issues on small screens (thanks to @nelsonPires5).
- Reliability: fixed OpenCode auth pass-through and proxy env handling to reduce intermittent connection/auth issues (thanks to @gsxdsm).

## [1.6.5] - 2026-02-6

- Settings: added an OpenCode CLI path override.
- Chat: added arrow-key prompt history and an optional setting to persist input drafts between restarts (thanks to @gsxdsm).
- Chat: thinking/reasoning blocks now render consistently, and justification visibility settings now apply reliably (thanks to @gsxdsm).
- Diff/Plans: added inline comment drafts (thanks to @nelsonPires5).
- Sessions: you can now rename projects directly from the sidebar, and issue/PR pickers are easier to scan when starting from GitHub context (thanks to @shekohex, @gsxdsm).
- Worktrees: improved worktree flow reliability, including cleaner handling when a worktree was already removed outside the app (thanks to @gsxdsm).
- Terminal: improved Android keyboard behavior and removed distracting native caret blink in terminal inputs (thanks to @shekohex).
- UI: added Vitesse Dark and Vitesse Light theme presets.
- Reliability: improved OpenCode binary resolution and HOME-path handling across runtimes for steady local startup.

## [1.6.4] - 2026-02-5

- Desktop: switch between local and remote OpenChamber instances, plus a thinner runtime.
- Mobile: split Agent/Model controls and a quick commands button with autocomplete (Commands/Agents/Files) for easier input (thanks to @Jovines, @gsxdsm).
- Chat: select text in messages to quickly add it to your prompt or start a new session (thanks to @gsxdsm).
- Diff/Plans: add inline comment drafts (thanks to @nelsonPires5).
- Terminal/Syntax: font size controls and Phoenix file extension support (thanks to @shekohex).
- Usage: expanded quota tracking with more providers (including GitHub Copilot) and a provider selector dropdown (thanks to @gsxdsm, @nelsonPires5).
- Git: improved macOS SSH agent support for smooth private-repo auth (thanks to @shekohex).
- Web: fixed missing icon when installing the Android PWA (thanks to @nelsonPires5).
- GitHub: PR description generation supports optional extra context (thanks to @nelsonPires5).

## [1.6.3] - 2026-02-2

- Web: improved server readiness check to use the `/global/health` endpoint.
- Web: added login rate limit protection to prevent brute-force attempts on the authentication endpoint (thanks to @Jovines).
- Settings: dialog no longer persists open/closed state across app restarts.

## [1.6.2] - 2026-02-1

- Usage: new multi-provider quota dashboard to monitor API usage across OpenAI, Google, and z.ai (thanks to @nelsonPires5).
- Settings: now opens in a windowed dialog on desktop with backdrop blur.
- Terminal: added tabbed interface to manage multiple terminal sessions per directory.
- Files: added multi-file tabs on desktop and dropdown selector on mobile (thanks to @nelsonPires5).
- UI: introduced a token-based theming system, 18 themes with light/dark variants, and custom user themes from `~/.config/pichamber/themes`.
- Diff: optimized stacked view with worker-pool processing and lazy DOM rendering for smooth scrolling.
- Worktrees: workspace path now resolves correctly when using git worktrees (thanks to @nelsonPires5).
- Projects: fixed directory creation outside workspace in the Add Project modal (thanks to @nelsonPires5).

## [1.6.1] - 2026-01-30

- Chat: added Stop button to cancel generation mid-response.
- Mobile: revamped chat controls on small screens with a unified controls drawer (thanks to @nelsonPires5).
- UI: update dialog now includes the changelog.
- Terminal: added optional on-screen key bar (Esc/Ctrl/arrows/Enter) for easier terminal navigation.
- Notifications: added "Notify for subtasks" toggle to silence child-session notifications during multi-run (thanks to @Jovines).
- Reliability: improved event-stream reconnection when the app becomes visible again.
- Worktrees: starting new worktree sessions now defaults to HEAD when no start point is provided.
- Git: commit message generation now includes untracked files and handles `git diff --no-index` comparisons reliably (thanks to @MrLYC).
- Desktop: improved macOS window chrome and header spacing, including steady traffic lights on older macOS versions (thanks to @yulia-ivashko).

## [1.6.0] - 2026-01-29

- Chat: added message stall detection with automatic soft resync.
- Chat: fixed "Load older" button behavior in chat with proper pagination implementation.
- Git: PR picker now validates local branch existence and includes a refresh action.
- Git: worktree integration now syncs clean target directories before merging.
- Diff: fixed memory leak when viewing many modified files; large changesets now lazy-load for smooth performance.
- Web: session activity tracking now works consistently across browser tabs.
- Reliability: plans directory no longer errors when missing.

## [1.5.9] - 2026-01-28

- Worktrees: migrated to the OpenCode SDK worktree implementation; sessions in worktrees are now completely isolated.
- Git: integrate worktree commits back to a target branch with commit previews and guided conflict handling.
- Files: toggle markdown preview when viewing files (thanks to @Jovines).
- Files: open the file viewer in fullscreen for focused review and editing (thanks to @TaylorBeeston).
- Plans: switch between markdown preview and edit mode in the Plan view.
- UI: Files, Diff, Git, and Terminal now follow the active session/worktree directory, including new-session drafts.
- Web: plan lists no longer error when the plans directory is missing.

## [1.5.8] - 2026-01-26

- Plans: new Plan/Build mode switching support with dedicated Plan content view with per-session context.
- GitHub: sign in with multiple accounts and smooth auth flow.
- Chat/UI: linkable mentions, better wrapping, and markdown/scroll polish in messages.
- Skills: ClawdHub catalog now pages results and retries transient failures.
- Diff: fixed Chrome scrolling in All Files layout.
- Mobile: improved layout for attachments, git, and permissions on small screens (thanks to @nelsonPires5).
- Web: iOS safe-area support for the PWA header.
- Activity: added a text-justification setting for activity summaries (thanks to @iyangdianfeng).
- Reliability: file lists and message sends handle missing directories and transient errors better.

## [1.5.7] - 2026-01-24

- GitHub: PR panel supports fork PR detection by branch name.
- GitHub: Git tab PR panel can send failed checks/comments to chat with hidden context; added check details dialog with Actions step breakdown.
- Web: GitHub auth flow fixes.

## [1.5.6] - 2026-01-24

- GitHub: connect your account in Settings with device-flow auth to enable GitHub tools.
- Sessions: start new sessions from GitHub issues with seeded context (title, body, labels, comments).
- Sessions: start new sessions from GitHub pull requests with PR context baked in (including diffs).
- Git: manage pull requests in the Git view with AI-generated descriptions, status checks, ready-for-review, and merge actions.
- Mobile: fixed CommandAutocomplete dropdown scrolling (thanks to @nelsonPires5).

## [1.5.5] - 2026-01-23

- Navigation: URLs now sync the active session, tab, settings, and diff state for shareable links and reliable back/forward (thanks to @TaylorBeeston).
- Settings: agent and command overrides now prefer plural directories while still honoring legacy singular folders.
- Skills: installs now target plural directories while still recognizing legacy singular folders.
- Web: push notifications no longer fire when a window is visible, avoiding duplicate alerts.
- Web: improved push subscription handling across multiple windows.

## [1.5.4] - 2026-01-22

- Chat: new Apply Patch tool UI with diff preview for patch-based edits.
- Files: refreshed attachment cards and related file views for clearer context.
- Settings: manage provider configuration files directly from the UI.
- UI: updated header and sidebar layout for a cleaner, tighter workspace fit (thanks to @TheRealAshik).
- Diff: large diffs now lazy-load to avoid freezes (thanks to @Jovines).
- Web: added Background notifications for PWA.
- Reliability: connect to external OpenCode servers without auto-start and fixed subagent crashes (thanks to @TaylorBeeston).

## [1.5.3] - 2026-01-20

- Files: edit files inline with syntax highlighting, draft protection, and save/discard flow.
- Files: toggles to show hidden/dotfiles and gitignored entries in file browsers and pickers (thanks to @syntext).
- Settings: new memory limits controls for session message history.
- Chat: smooth session switching with more stable scroll anchoring.
- Chat: new Activity view in collapsed state, now shows latest 6 tools by default.
- Chat: fixed message copy on Firefox for macOS (thanks to @syntext).
- Appearance: new corner radius control and restored input bar offset setting (thanks to @TheRealAshik).
- Git: generated commit messages now auto-pick a gitmoji when enabled (thanks to @TheRealAshik).
- Performance: faster filesystem/search operations and general stability improvements (thanks to @TheRealAshik).

## [1.5.2] - 2026-01-17

- Sessions: added branch picker dialog to start new worktree sessions from local branches (thanks to @nilskroe).
- Sessions: added project header worktree button, active-session loader, and right-click context menu in the sessions sidebar (thanks to @nilskroe).
- Sessions: improved worktree delete dialog with linked session details, dirty-change warnings, and optional remote branch removal.
- Git: added gitmoji picker in commit message composer with cached emoji list (thanks to @TaylorBeeston).
- Chat: optimized message loading for opening sessions.
- UI: added one-click diagnostics copy in the About dialog.
- Reliability: improved OpenCode process cleanup to reduce orphaned servers.

## [1.5.1] - 2026-01-16

- Desktop: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- OpenCode: fixed a crash when reloading configuration.

## [1.5.0] - 2026-01-16

- UI: added a new Files tab to browse workspace files directly from the interface.
- Diff: enhanced the diff viewer with mobile support and the ability to ask the agent for comments on changes.
- Git Identities: added "default identity" setting with one-click set/unset and automatic local identity detection.
- Web: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Web: the server now automatically resolves and uses an available port if the default is occupied.
- Stability: fixed heartbeat race condition causing session stalls during long tasks (thanks to @tybradle).
- Desktop: fixed commands for worktree setup access to PATH.

## [1.4.9] - 2026-01-14

- Diff: added stacked/inline diff mode toggle in settings with sidebar file navigation (thanks to @nelsonPires5).
- Mobile: fixed iOS keyboard safe area padding for home indicator bar (thanks to @Jovines).
- Upload: increased attachment size limit to 50MB with automatic image compression to 2048px for large files.

## [1.4.8] - 2026-01-14

- Git Identities: added token-based authentication support with ~/.git-credentials discovery and import.
- Settings: consolidated Git settings and added opencode zen model selection for commit generation (thanks to @nelsonPires5).
- Web Notifications: added configurable native web notifications for assistant completion (thanks to @vio1ator).
- Chat: sidebar sessions are now automatically sorted by last updated date (thanks to @vio1ator).
- Chat: fixed edit tool output and added turn duration.
- UI: todo lists and status indicators now hide automatically when all tasks are completed (thanks to @vio1ator).
- Reliability: improved project state preservation on validation failures (thanks to @vio1ator) and refined server health monitoring.
- Stability: added graceful shutdown handling for the server process (thanks to @vio1ator).

## [1.4.7] - 2026-01-10

- Skills: added ClawdHub integration as built-in market for skills.
- Web: fixed issues in terminal.

## [1.4.6] - 2026-01-09

- Input: removed auto-complete and auto-correction.
- Shortcuts: switched the agent cycling shortcut from Shift+Tab back to Tab.
- Chat: added question tool support with a rich UI for interaction.

## [1.4.5] - 2026-01-08

- Chat: added support for model variants (thinking effort).
- Shortcuts: switched the agent cycling shortcut from Tab to Shift+Tab.
- Skills: added autocomplete for skills on "/" when it is not the first character in input.
- Autocomplete: added scope badges for commands/agents/skills.
- Compact: changed `/summarize` to `/compact` and moved compaction to the SDK.
- MCP: added the ability to dynamically enable or disable configured MCP servers.
- Web: refactored the Add Project UI with autocomplete.

## [1.4.4] - 2026-01-08

- Agent Manager / Multi Run: select agent per worktree session (thanks to @wienans).
- Agent Manager / Multi Run: worktree actions to delete group or individual worktrees, or keep only selected one (thanks to @wienans).
- Agent Manager: added "Copy Worktree Path" action in the more menu (thanks to @wienans).
- Worktrees: added session creation flow with loading screen, auto-create worktree setting, and setup commands management.
- Session sidebar: refactored the unified view for sessions in worktrees.
- Settings: added the ability to create new sessions in worktrees by default.
- Git view: added branch rename for worktree.
- Chat: fixed IME composition for CJK input to prevent accidental send (thanks to @madebyjun).
- Projects: added multi-project support with per-project settings for agents/commands/skills.
- Event stream: improved SSE with heartbeat management, permission bootstrap on connect, and reconnection logic.
- Tunnel: added QR code and password URL for Cloudflare tunnel (thanks to @martindonadieu).
- Model selector: fixed dropdowns not responding to viewport size.

## [1.4.3] - 2026-01-04

- VS Code extension: added Agent Manager panel to run the same prompt across up to 5 models in parallel (thanks to @wienans).
- Added permission prompt UI for tools configured with "ask" in opencode.json, showing requested patterns and "Always Allow" options (thanks to @aptdnfapt).
- Added "Open subAgent session" button on task tool outputs to quickly navigate to child sessions (thanks to @aptdnfapt).
- VS Code extension: improved activation reliability and error handling.

## [1.4.2] - 2026-01-02

- Added timeline dialog (`/timeline` command or Cmd/Ctrl+T) for navigating, reverting, and forking from any point in the conversation (thanks to @aptdnfapt).
- Added `/undo` and `/redo` commands for reverting and restoring messages in a session (thanks to @aptdnfapt).
- Added fork button on user messages to create a new session from any point (thanks to @aptdnfapt).
- Desktop app: keyboard shortcuts now use Cmd on macOS and Ctrl on web/other platforms (thanks to @sakhnyuk).
- Migrated to OpenCode SDK v2 with improved API types and streaming.

## [1.4.1] - 2026-01-02

- Added the ability to select the same model multiple times in multi-agent runs for response comparison.
- Model selector now includes search and keyboard navigation.
- Added revert button to all user messages (including first one).
- Added HEIC image support for file attachments with automatic MIME type normalization for text format files.
- VS Code extension: added Git backend integration for UI access (thanks to @wienans).
- VS Code extension: only shows the main Worktree in the Chat Sidebar (thanks to @wienans).
- Web app: terminal backend now supports a faster Bun-based PTY when Bun is available, with automatic fallback for existing Node-only setups.
- Terminal: improved terminal performance and stability by switching to the Ghostty-based terminal renderer, while keeping the existing terminal UX and per-directory sessions.
- Terminal: fixed several issues with terminal session restore and rendering under heavy output, including switching directories and long-running TUI apps.

## [1.4.0] - 2026-01-01

- Added the ability to run multiple agents from a single prompt, with each agent working in an isolated worktree.
- Git view: improved branch publishing by detecting unpublished commits and automatically setting the upstream on first push.
- Worktrees: new branch creation can start from a chosen base; remote branches are only created when you push.
- VS Code extension: default location is now the right secondary sidebar in VS Code, and the left activity bar in Cursor/Windsurf; navigation moved into the title bar (thanks to @wienans).
- Web app: added Cloudflare Quick Tunnel support for simpler remote access (thanks to @wojons and @aptdnfapt).
- Mobile: improved keyboard/input bar behavior (including Android fixes and better keyboard avoidance) and added an offset setting for curved-screen devices (thanks to @auroraflux).
- Chat: now shows clearer error messages when agent messages fail.
- Sidebar: improved readability for sticky headers with a dynamic background.

## [1.3.9] - 2025-12-30

- Added skills management to settings with the ability to create, edit, and delete skills (make sure you have the latest OpenCode version for skills support).
- Added Skills catalog functionality for discovering and installing skills from external sources.
- VS Code extension: added right-click context menu with "Add to Context," "Explain," and "Improve Code" actions (thanks to @wienans).

## [1.3.8] - 2025-12-29

- Added Intel Mac (x86_64) support for the desktop application (thanks to @rothnic).
- Build workflow now generates separate builds for Apple Silicon (arm64) and Intel (x86_64) Macs (thanks to @rothnic).
- Improved dev server HMR by reusing a healthy OpenCode process to avoid zombie instances.
- Added queued message mode with chips, batching, and idle auto‑send (including attachments).
- Added queue mode toggle to OpenChamber settings (chat section) with persistence across runtimes.
- Fixed scroll position persistence for active conversation turns across session switches.
- Refactored Agents/Commands management with ability to configure project/user scopes.

## [1.3.7] - 2025-12-28

- Redesigned Settings as a full-screen view with tabbed navigation.
- Added mobile-friendly drill-down navigation for settings.
- ESC key now closes settings; double-ESC abort only works on chat tab without overlays.
- Added responsive tab labels in settings header (icons only at narrow widths).
- Improved session activity status handling and message step completion logic.

## [1.3.6] - 2025-12-27

- Added the ability to manage (connect/disconnect) providers in settings.
- Adjusted auto-summarization visuals in chat.

## [1.3.5] - 2025-12-26

- Added Nushell support for OpenCode CLI operations.
- Improved file search with fuzzy matching capabilities.
- Enhanced mobile responsiveness in chat controls.
- Fixed workspace switching performance and API health checks.
- Improved provider loading reliability during workspace switching.
- Fixed session handling for non-existent worktree directories.
- Added Discord links in the about section.
- Added settings for choosing the default model/agent to start with in a new session.

## [1.3.4] - 2025-12-25

- Diff view now loads reliably even with large files and slow networks.
- Fixed getting diffs for worktree files.
- VS Code extension: improved type checking and editor integration.

## [1.3.3] - 2025-12-25

- Updated OpenCode SDK to 1.0.185 across all app versions.
- VS Code extension: fixed startup, more reliable OpenCode CLI/API management, and stabilized API proxying/streaming.
- VS Code extension: added an animated loading screen and introduced command for status/debug output.
- Fixed session activity tracking.
- Fixed directory path handling (including `~` expansion) to prevent invalid paths and related Git/worktree errors.
- Chat UI: improved turn grouping/activity rendering and fixed message metadata/agent selection propagation.
- Chat UI: improved agent activity status behavior and reduced image thumbnail sizes.

## [1.3.2] - 2025-12-22

- Fixed new bug session when switching directories.
- Updated OpenCode SDK to the latest version.

## [1.3.1] - 2025-12-22

- New chats no longer create a session until you send your first message.
- The app opens to a new chat by default.
- Fixed mobile sessions handling.
- Updated app identity with new logo and icons across all platforms.

## [1.3.0] - 2025-12-21

- Added revert functionality in chat for user messages.
- Polished mobile controls in chat view.
- Updated user message layout/styling.
- Improved header tab responsiveness.
- Polished file autocomplete experience.

## [1.2.9] - 2025-12-20

- Added session auto-cleanup with configurable retention across app versions.
- Added web package updates from the mobile/PWA settings view.
- Added several optimizations for long sessions.

## [1.2.8] - 2025-12-19

- Added a web update flow that does not require CLI interaction.
- Added a web install script with package manager detection.
- Web server update/restart now reuses previously set parameters like port or password.

## [1.2.7] - 2025-12-19

- Comprehensive macOS native menu bar entries.
- Redesigned directory selection view for web/mobile with improved layout.
- Improved theme consistency across dropdown menus, selects, and command palette.
- Introduced keyboard shortcuts help menu and quick actions menu.

## [1.2.6] - 2025-12-19

- Added write/create tool preview in permission cards with syntax highlighting.
- More descriptive assistant status messages with tool-specific and varied idle phrases.
- Polished Git view layout.

## [1.2.5] - 2025-12-19

- Polished the chat experience for longer sessions.
- Fixed file links from Git view to Diff.
- Improved inactive-state handling in the Desktop app.
- Redesigned Git tab layout with improved organization.
- Fixed untracked files in new directories not showing individually.
- Smoother session rename experience.

## [1.2.4] - 2025-12-18

- Added macOS app menu entries for Check for Update and bug/request reports in Help.
- Mobile: added settings, improved terminal scrolling, and fixed app layout positioning.

## [1.2.3] - 2025-12-17

- Added image preview support in Diff tab (shows original/modified images instead of base64 code).
- Improved diff view visuals and aligned styling across widgets.
- Optimized Git polling and background diff/syntax pre-warming for faster Diff tab opening.
- Optimized reloading unaffected diffs.

## [1.2.2] - 2025-12-17

- Agent Task tool now renders progressively with live duration and completed sub-tools summary.
- Unified markdown rendering between assistant messages and tool outputs.
- Reduced markdown header sizes.

## [1.2.1] - 2025-12-16

- Todo task tracking: collapsible status row showing AI's current task and progress.
- Switched "Detailed" tool output mode to only open the 'task', 'edit', 'multiedit', 'write', 'bash' tools.

## [1.2.0] - 2025-12-15

- Favorite & recent models for quick access in model selection.
- Tool call expansion settings: collapsed, activity, or detailed modes.
- Font size & spacing controls (50-200% scaling) in Appearance Settings.
  Thanks to @theblazehen for contributing these features!

## [1.1.6] - 2025-12-15

- Optimized diff view layout with smaller fonts and compact hunk separators.
- Improved mobile experience: simplified header, better diff file selector.
- Redesigned password-protected session unlock screen.

## [1.1.5] - 2025-12-15

- Improved file attachment performance.
- Added fuzzy search for file mentions with `@` in chat.
- Optimized input area layout.

## [1.1.4] - 2025-12-15

- Flexoki themes for Shiki syntax highlighting for consistency with the app color schema.
- Fixed mobile view model/agent selection.

## [1.1.3] - 2025-12-14

- Replaced Monaco diff editor with Pierre/diffs.
- Added line wrap toggle in diff view with dynamic layout switching (auto-inline when narrow).

## [1.1.2] - 2025-12-13

- Moved VS Code extension to activity bar (left sidebar).
- Added feedback messages for "Restart API Connection" command.
- Removed redundant VS Code commands.
- Enhanced UserTextPart styling.

## [1.1.1] - 2025-12-13

- Adjusted model/agent selection alignment.
- Fixed user message rendering issues.

## [1.1.0] - 2025-12-13

- Added assistant answer fork flow.
- Added OpenChamber VS Code extension with editor integration: file picker, click-to-open in tool parts.
- Improved scroll performance with force flag and RAF placeholder.
- Added git polling backoff optimization.

## [1.0.9] - 2025-12-08

- Added directory picker on first launch to reduce macOS permission prompts.
- Show changelog in update dialog from current to new version.
- Improved update dialog UI with inline version display.
- Added macOS folder access usage descriptions.

## [1.0.8] - 2025-12-08

- Added fallback detection for OpenCode CLI in `~/.opencode/bin`.
- Added window focus after app restart/update.
- Adapted traffic lights position and corner radius for older macOS versions.

## [1.0.7] - 2025-12-08

- Optimized OpenCode binary detection.
- Adjusted app update experience.

## [1.0.6] - 2025-12-08

- Enhanced shell environment detection.

## [1.0.5] - 2025-12-07

- Fixed "Load older messages" incorrectly scrolling to bottom.
- Fixed page refresh getting stuck on splash screen.
- Disabled devtools and page refresh in production builds.

## [1.0.4] - 2025-12-07

- Optimized desktop app start time.

## [1.0.3] - 2025-12-07

- Updated onboarding UI.
- Updated sidebar styles.

## [1.0.2] - 2025-12-07

- Updated macOS window design.

## [1.0.1] - 2025-12-07

- Initial public release of OpenChamber web and desktop packages in a unified monorepo.
- Added GitHub Actions release pipeline with macOS signing/notarization, npm publish, and release asset uploads.
- Introduced OpenCode agent chat experience with section-based navigation, theming, and session persistence.
