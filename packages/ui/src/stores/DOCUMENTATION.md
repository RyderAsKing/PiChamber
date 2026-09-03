# UI Stores

`packages/ui/src/stores` owns shared Zustand state for PiChamber UI preferences and Pi-native resource views.

Use a store only for state shared across distant component trees or for a cache whose ownership is explicit. Keep high-frequency session events in the Pi session store rather than broad UI stores, and use narrow selectors so unrelated UI does not rerender.

## Ownership

- `useUIStore.ts`: local UI layout, dialogs, and presentation preferences. `ui/contextPanel.ts` owns context-panel tabs, deduplication, width clamping, and directory-scoped persistence sanitization.
- `useDirectoryStore.ts`, `useProjectsStore.ts`, `useGitStore.ts`, `useWorktreeStore.ts`, `useWorktreeCreationStore.ts`, `useTerminalStore.ts`, `useFilesStore.ts`: workspace chrome for Files/Git/Terminal against `/api/fs`, `/api/git`, `/api/terminal`. `useWorktreeStore` owns runtime-scoped authoritative Git worktree topology per registered project; refresh failure preserves the previous list and remains distinct from successful empty discovery. `useWorktreeCreationStore` owns in-memory, runtime-scoped draft worktree creation progress so naming/create/bootstrap polling survives composer unmounts; concurrent requests for the same intent share one in-flight promise, stale generations never overwrite a newer entry, and a successful `setup-ready` worktree still records a receipt if project refresh fails. Automatic PiChamber-era project-icon discovery is an intentional unsupported no-op until Pi-native icon storage has an owning contract.
- `useSkillsStore.ts`: Pi resource-discovery state. Skill paths are opaque daemon identifiers, never filesystem paths.
- `useSnippetsStore.ts`: Pi prompt-template UI state.
- `useConfigStore.ts` orchestrates project-scoped provider/agent state and publishes picker selections. `config/defaults.ts` owns runtime/sidecar default precedence, `config/selection.ts` owns model/agent selection policy, `config/directoryScope.ts` owns project/worktree config routing plus its runtime-scoped persisted worktree mapping, and `config/modelMetadata.ts` owns models.dev validation, fetch deduplication, and live-provider metadata fallback.

`useSessionFoldersStore.ts` keeps a runtime-scoped browser snapshot for immediate continuity and reconciles it with the active server's validated `/api/pi/session-folders` sidecar. Missing server state is not authoritative empty state, and in-flight hydration cannot replace newer local mutations.

Caches and async work must be scoped to the active runtime. A failed authoritative request must preserve existing state and remain distinguishable from a successful empty result.

`useWorktreeStore.refreshProject()` coalesces discovery by runtime and project, rejects stale runtime completions, and keeps linked-worktree arrays reference-stable when topology is unchanged. `WorktreeDiscovery` refreshes with bounded concurrency while the app is visible; hidden UI does no polling.

`useGitStore.fetchBranches()` coalesces concurrent loads by runtime and directory. Composer, dialog, and Git-surface mounts share one request; a runtime switch clears the in-flight owner so an old host cannot commit into the new store.

`useProjectsStore.resetForRuntimeSwitch()` clears project paths until the new
runtime's authenticated settings snapshot arrives; persisted paths from another
host are not a valid bootstrap source. `setActiveProjectIdOnly()` changes and
persists only the active pointer. It preserves the `projects` array and project
metadata references so session or worktree navigation does not wake every
project-list consumer.

When changing store shape, keep persisted state intentionally compatible or discard obsolete fields safely. Do not use persisted history to infer live Pi activity.
