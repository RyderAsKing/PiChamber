/* eslint-disable */
// @ts-nocheck
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
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';

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
 * Bridges the Pi-native runtime into the legacy directory/project/session UI
 * stores. PiSessionStore is authoritative: it adopts the daemon's selected
 * project and auto-selects the first session. The legacy stores still drive the
 * composer and provider/agent config, so we converge them onto the Pi store's
 * resolved directory and selected session.
 */
const PiSessionBootstrapBridge: React.FC = () => {
  const store = React.useMemo(() => getPiSessionStore(), []);
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { selectedSessionId, directory } = snapshot;

  // Converge the legacy directory + project stores onto the daemon's project
  // so provider/agent config and session listing resolve against it.
  React.useEffect(() => {
    if (!directory) return;
    const projects = useProjectsStore.getState();
    const existing = projects.projects.find((project) => project.path === directory);
    if (!existing) {
      projects.addProject(directory);
    } else if (projects.activeProjectId !== existing.id) {
      projects.setActiveProject(existing.id);
    } else if (useDirectoryStore.getState().currentDirectory !== directory) {
      useDirectoryStore.getState().setDirectory(directory, { showOverlay: false });
    }
    // Re-activate provider/agent config against the daemon's authoritative
    // directory. If initializeApp ran before the Pi store resolved its
    // project (or had no legacy project to fall back to), this is what loads
    // the composer's provider/model selection.
    void useConfigStore.getState().activateDirectory(directory);
  }, [directory]);

  // Bridge the Pi auto-selected session into the legacy session UI store, whose
  // `currentSessionId` the composer still reads. Without this the composer has
  // no target session and silently drops sends.
  React.useEffect(() => {
    if (!selectedSessionId || !directory) return;
    const ui = useSessionUIStore.getState();
    if (ui.currentSessionId === null) {
      useSessionUIStore.setState({
        currentSessionId: selectedSessionId,
        currentSessionDirectory: directory,
      });
      markSessionViewed(selectedSessionId);
    }
  }, [selectedSessionId, directory]);

  return null;
};

const ConfigStoreBootstrap: React.FC = () => {
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const providersCount = useConfigStore((state) => state.providers.length);

  React.useEffect(() => {
    void initializeApp();
  }, [initializeApp]);

  React.useEffect(() => {
    if (isInitialized) return;
    let active = true;
    let retryCount = 0;
    const id = window.setInterval(() => {
      if (!active) return;
      retryCount += 1;
      if (retryCount > 10) {
        window.clearInterval(id);
        return;
      }
      if (!useConfigStore.getState().isInitialized) {
        void useConfigStore.getState().initializeApp();
      }
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [isInitialized]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'webApp:recovery' });
  }, [isConnected, loadProviders, providersCount]);

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
