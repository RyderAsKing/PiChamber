import React from 'react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { useQueuedMessageAutoSend } from '@/hooks/useQueuedMessageAutoSend';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';
import { setOptimisticRefs } from '@/sync/session-actions';
import { markSessionViewed } from '@/sync/notification-store';
import { setExternallyViewedSession } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { parseRoute } from '@/lib/router';

const MINI_CHAT_PRESENCE_CHANNEL = 'openchamber:mini-chat-presence';

type MiniChatPresenceMessage = {
  type?: string;
  sessionId?: string;
  directory?: string;
  viewed?: boolean;
};

const SyncOptimisticBridge: React.FC = () => {
  const sync = useSync();
  const addRef = React.useRef(sync.optimistic.add);
  const removeRef = React.useRef(sync.optimistic.remove);
  const confirmRef = React.useRef(sync.optimistic.confirm);
  addRef.current = sync.optimistic.add;
  removeRef.current = sync.optimistic.remove;
  confirmRef.current = sync.optimistic.confirm;

  React.useEffect(() => {
    setOptimisticRefs(
      (input) => addRef.current(input),
      (input) => removeRef.current(input),
      (input) => confirmRef.current(input),
    );
  }, []);

  return null;
};

const MiniChatPresenceBridge: React.FC = () => {
  React.useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(MINI_CHAT_PRESENCE_CHANNEL);
    channel.onmessage = (event) => {
      const data = event.data as MiniChatPresenceMessage | null;
      if (data?.type !== 'mini-chat-session-presence' || !data.sessionId || !data.directory) {
        return;
      }

      const viewed = data.viewed !== false;
      setExternallyViewedSession(data.directory, data.sessionId, viewed);
      if (viewed) {
        markSessionViewed(data.sessionId);
      }
    };

    return () => channel.close();
  }, []);

  return null;
};

export function SyncRuntimeEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  useSessionAutoCleanup(embeddedBackgroundWorkEnabled);
  useQueuedMessageAutoSend(embeddedBackgroundWorkEnabled);

  return <SyncOptimisticBridge />;
}

/**
 * Bridges the Pi-native runtime into the restored session UI stores. The
 * user-owned project store chooses the directory; the daemon must never create
 * or resurrect a visible project from its process working directory.
 */
const PiSessionBootstrapBridge: React.FC = () => {
  const store = React.useMemo(() => getPiSessionStore(), []);
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { selectedSessionId, directory, connection } = snapshot;

  React.useEffect(() => {
    if (!directory) return;
    if (useDirectoryStore.getState().currentDirectory !== directory) {
      useDirectoryStore.getState().setDirectory(directory, { showOverlay: false });
    }
    void useConfigStore.getState().activateDirectory(directory);
  }, [directory]);

  // The composer still reads the restored session UI store. Keep its complete
  // identity synchronized, including project switches and the no-project state.
  React.useEffect(() => {
    const ui = useSessionUIStore.getState();
    if (!selectedSessionId || !directory) {
      if (connection === 'loading') {
        return;
      }
      if (ui.currentSessionId !== null || ui.currentSessionDirectory !== null) {
        useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
      }
      return;
    }
    // When a new session draft is intentionally open, background directory switches
    // (such as changing the project picker on the new session page) must not force-open
    // the project's last session and dismiss the draft, unless a specific session was deep-linked.
    const hasExplicitRouteSession = typeof window !== 'undefined' && Boolean(parseRoute().sessionId);
    if (ui.newSessionDraft?.open && ui.currentSessionId === null && !hasExplicitRouteSession) {
      return;
    }
    if (ui.currentSessionId !== selectedSessionId || ui.currentSessionDirectory !== directory) {
      // Close any open draft together with the session switch. The bridge
      // intentionally uses setState (not setCurrentSession) to avoid
      // duplicating session lifecycle work, but that bypasses
      // closeNewSessionDraft(). Without this, ChatInput still sees
      // newSessionDraft.open === true and renders draft-mode UI (welcome
      // title, preset chips) even after the session has loaded.
      const draftUpdate = ui.newSessionDraft?.open
        ? {
            newSessionDraft: {
              open: false as const,
              selectedProjectId: null,
              directoryOverride: null,
              preserveDirectoryOverride: false,
              parentID: null,
              title: undefined,
              initialPrompt: undefined,
              syntheticParts: undefined,
              targetFolderId: undefined,
            },
          }
        : {};
      useSessionUIStore.setState({
        currentSessionId: selectedSessionId,
        currentSessionDirectory: directory,
        ...draftUpdate,
      });
      markSessionViewed(selectedSessionId);
    }
  }, [selectedSessionId, directory, connection]);

  return null;
};

const ConfigStoreBootstrap: React.FC = () => {
  const store = React.useMemo(() => getPiSessionStore(), []);
  const pi = React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const providersCount = useConfigStore((state) => state.providers.length);

  React.useEffect(() => {
    if (!pi.directory || pi.connection !== 'ready' || isInitialized) return;
    void initializeApp();
  }, [initializeApp, isInitialized, pi.connection, pi.directory]);

  React.useEffect(() => {
    if (!pi.directory || pi.connection !== 'ready' || !isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'webApp:recovery' });
  }, [isConnected, loadProviders, pi.connection, pi.directory, providersCount]);

  return null;
};

export function SyncAppEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();

  return (
    <>
      <ConfigStoreBootstrap />
      <SyncRuntimeEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
      <PiSessionBootstrapBridge />
      <MiniChatPresenceBridge />
    </>
  );
}
