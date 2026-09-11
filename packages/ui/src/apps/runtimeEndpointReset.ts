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

// Same-device transport switch (LAN⇄relay for one paired device): rebind the Pi transport
// to the new transport WITHOUT tearing down connection/session state or remounting
// the sync layer. `reconnectToRuntimeBaseUrl` swaps in a fresh Pi transport; the
// caller then forces a re-render so PiSessionProvider receives it as a new `sdk` prop,
// which re-runs its event-pipeline + bootstrap effects (keyed on `sdk`) to
// reconnect over the new transport IN PLACE. Message-pagination refs, the open
// session, and the whole view are preserved — no reconnecting screen, no flash,
// no bounce back to the draft.
//
// Terminal: resetting the transport bumps the explicit terminal generation
// (see terminalApi). Mounted terminal consumers reattach the SAME runtime's
// SAME PTY IDs once per generation — never recreating or killing the PTY.
// Tabs, scrollback buffers, viewport dims, and xterm selection stay owned by
// the terminal store/viewport refs and are preserved here. Auth/URL/relay
// routing is unchanged (shared runtime-auth + resolver + openRuntimeWebSocket).
// Pending input sent while the socket is down is dropped, not replayed.
export const reconnectAppForTransportSwitch = (): void => {
  resetTerminalTransport();
};

export const resetAppForRuntimeEndpointChange = (detail: RuntimeEndpointChangedDetail): void => {
  useSessionUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  useUIStore.getState().prepareForRuntimeSwitch(detail.previousRuntimeKey);
  // Different runtime: never reuse old PTY IDs. Clear tabs/buffers BEFORE
  // bumping the terminal generation: the generation handler checks store
  // ownership synchronously, so clearing first prevents reattaching old IDs
  // on the new runtime. Resetting then bumps the generation (rejecting late
  // callbacks/data from the old transport). A same-ID PTY on the new runtime
  // is a different PTY. Listeners/timers of the old transport are released
  // by dispose().
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
