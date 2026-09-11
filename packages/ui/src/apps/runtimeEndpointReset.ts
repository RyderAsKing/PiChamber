import type { RuntimeEndpointChangedDetail } from '@/lib/runtime-switch';
import { resetTerminalTransport } from '@/lib/terminalApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useGitStore } from '@/stores/useGitStore';
import { useWorktreeStore } from '@/stores/useWorktreeStore';
import { useWorktreeCreationStore } from '@/stores/useWorktreeCreationStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { usePromptTemplatesStore } from '@/stores/usePromptTemplatesStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { clearCommandCatalogForRuntimeSwitch } from '@/lib/pi/commandCatalog';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resetSessionOrdering } from '@/sync/session-ordering';
import { resetSessionActivityTiming } from '@/sync/session-activity-timing';
import { updateBrowserURL } from '@/lib/router';

// A same-device LAN⇄relay switch preserves the mounted sync and terminal state.
// Resetting the terminal transport prompts mounted views to reattach their PTYs.
export const reconnectAppForTransportSwitch = (): void => {
  resetTerminalTransport();
};

export const resetAppForRuntimeEndpointChange = (detail: RuntimeEndpointChangedDetail): void => {
  useSessionUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  useUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  // Clear ownership before the generation bump so mounted views cannot attach
  // an old PTY ID on the new runtime.
  useTerminalStore.getState().clearAll();
  resetTerminalTransport();
  // The previous runtime's cwd is not meaningful on the new host (for
  // example, a Windows path must never be sent to a WSL daemon). Clear it
  // before the new runtime's settings/project snapshot is applied.
  useDirectoryStore.getState().resetForRuntimeSwitch();
  useSnippetsStore.getState().resetForRuntimeSwitch();
  usePromptTemplatesStore.getState().resetForRuntimeSwitch();
  // Command and starter catalogs are runtime-scoped; stale previous-server
  // rows must never render for the new runtime.
  clearCommandCatalogForRuntimeSwitch();
  useSkillsStore.getState().resetForRuntimeSwitch();
  useConfigStore.setState({
    providers: [],
    isConnected: false,
    isInitialized: false,
    connectionPhase: 'connecting',
    lastDisconnectReason: null,
  });
  useProjectsStore.getState().resetForRuntimeSwitch();
  // Global-list isolation is owned by PiSessionStore (`resetForRuntime` via
  // the runtime-endpoint subscription clears the catalog, generations, and
  // tombstones). No wrapper reset remains.
  resetSessionOrdering();
  // Turn timings belong to the previous instance's sessions, and the reset also
  // restarts the resume window so the switch is treated as a fresh load.
  resetSessionActivityTiming();
  usePermissionStore.getState().reset();
  useFileSearchStore.getState().resetForRuntimeSwitch();
  useGitStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useWorktreeStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useWorktreeCreationStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useGitHubPrStatusStore.getState().resetForRuntimeSwitch();
  useSessionFoldersStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useFilesViewTabsStore.getState().resetForRuntimeSwitch(detail.runtimeKey);
  useSessionUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  useUIStore.getState().restoreForRuntimeSwitch(detail.runtimeKey);
  const uiState = useUIStore.getState();
  updateBrowserURL({
    sessionId: useSessionUIStore.getState().currentSessionId,
    tab: uiState.activeMainTab,
    isSettingsOpen: uiState.isSettingsDialogOpen,
    settingsPath: uiState.settingsPage,
    diffFile: uiState.pendingDiffFile,
  }, { replace: true, force: true });
};
