import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/index.css';
import { getDeviceInfo } from '@/lib/device';
import { markAppBootReady } from './appBootReady';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { MobileApp } from './MobileApp';

export function renderMobileApp() {
  window.__OPENCHAMBER_SURFACE__ = 'mobile';
  initializeLocale();
  markAppBootReady();
  getDeviceInfo();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  const capacitor = (window as typeof window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const isNativeShell = capacitor?.isNativePlatform?.() === true || window.location.protocol === 'capacitor:';
  const app = <MobileApp />;

  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        {isNativeShell ? app : <SessionAuthGate>{app}</SessionAuthGate>}
      </I18nProvider>
    </StrictMode>,
  );
}
