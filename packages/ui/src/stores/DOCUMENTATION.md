# UI Stores

`packages/ui/src/stores` owns shared Zustand state for PiChamber UI preferences and Pi-native resource views.

Use a store only for state shared across distant component trees or for a cache whose ownership is explicit. Keep high-frequency session events in the Pi session store rather than broad UI stores, and use narrow selectors so unrelated UI does not rerender.

## Ownership

- `useUIStore.ts`: local UI layout, dialogs, and presentation preferences.
- `useDirectoryStore.ts`, `useProjectsStore.ts`, `useGitStore.ts`, `useTerminalStore.ts`, `useFilesStore.ts`: workspace chrome for Files/Git/Terminal against `/api/fs`, `/api/git`, `/api/terminal`.
- `useSkillsStore.ts`: Pi resource-discovery state. Skill paths are opaque daemon identifiers, never filesystem paths.
- `useSnippetsStore.ts` and `useMagicPromptsStore.ts`: Pi prompt-template and PiChamber magic-prompt UI state.

Caches and async work must be scoped to the active runtime. A failed authoritative request must preserve existing state and remain distinguishable from a successful empty result.

When changing store shape, keep persisted state intentionally compatible or discard obsolete fields safely. Do not use persisted history to infer live Pi activity.
