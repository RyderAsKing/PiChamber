import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts';
import './index.css';
import App from './App.tsx';
import { SessionAuthGate } from './components/auth/SessionAuthGate';
import { ThemeProvider } from './components/providers/ThemeProvider';
import { ThemeSystemProvider } from './contexts/ThemeSystemContext';
import { getRegisteredRuntimeAPIs } from './contexts/runtimeAPIRegistry';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
      <ThemeSystemProvider>
        <ThemeProvider>
          <SessionAuthGate>
            <App apis={getRegisteredRuntimeAPIs() ?? undefined} />
          </SessionAuthGate>
        </ThemeProvider>
      </ThemeSystemProvider>
  </StrictMode>,
);
