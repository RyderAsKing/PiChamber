import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/index.css';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { initializeLocale, I18nProvider } from '@/lib/i18n';
import App from '../App';

export function renderElectronMiniChatApp() {
  initializeLocale();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <SessionAuthGate>
          <App />
        </SessionAuthGate>
      </I18nProvider>
    </StrictMode>,
  );
}
