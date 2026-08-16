import { createConfiguredWebAPIs } from './runtimeConfig';
import type { RuntimeAPIs } from '@pichamber/ui/lib/api/types';
import '@pichamber/ui/index.css';
import '@pichamber/ui/styles/fonts';

declare global {
  interface Window {
    __PICHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__PICHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

void import('@pichamber/ui/apps/renderMobileApp')
  .then(({ renderMobileApp }) => {
    renderMobileApp();
  });
