import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/index.css';
import '@/lib/debug';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs } from '@/lib/api/types';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { initializeAppearancePreferences, syncDesktopSettings } from '@/lib/persistence';
import { startModelPrefsAutoSave } from '@/lib/modelPrefsAutoSave';
import { startTypographyWatcher } from '@/lib/typographyWatcher';
import { ElectronMiniChatApp } from './ElectronMiniChatApp';

const initializeSharedPreferences = () => {

  void initializeAppearancePreferences().then(() => {
    void Promise.all([
      syncDesktopSettings(),
      applyPersistedDirectoryPreferences(),
    ]).catch((err) => {
      console.error('[mini-chat-main] settings init failed:', err);
    });

    startAppearanceAutoSave();
    startModelPrefsAutoSave();
    startTypographyWatcher();
  }).catch((err) => {
    console.error('[mini-chat-main] appearance init failed:', err);
  });
};

export function renderElectronMiniChatApp(apis?: RuntimeAPIs) {
  const resolved = apis ?? getRegisteredRuntimeAPIs();
  if (!resolved) {
    throw new Error('Runtime APIs not registered');
  }
  initializeSharedPreferences();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  createRoot(rootElement).render(
    <StrictMode>
        <ThemeSystemProvider>
              <SessionAuthGate>
              <ElectronMiniChatApp apis={resolved} />
            </SessionAuthGate>
          </ThemeSystemProvider>
    </StrictMode>,
  );
}
