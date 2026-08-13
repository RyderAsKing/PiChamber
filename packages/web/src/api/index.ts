import type { RuntimeAPIs } from '@pichamber/ui/lib/api/types';
import {
  createRuntimeUrlResolver,
  getRuntimeUrlResolver,
  setRuntimeUrlResolver,
  type RuntimeUrlResolver,
} from '@pichamber/ui/lib/runtime-url';

export interface WebAPIsOptions {
  urls?: RuntimeUrlResolver;
}

/**
 * The mounted application uses the Pi HTTP facade directly. Retain the runtime
 * descriptor for shell compatibility without importing legacy runtime-backed
 * web API implementations into the browser bundle.
 */
export const createWebAPIs = (options: WebAPIsOptions = {}): RuntimeAPIs => {
  const urls = options.urls ?? createRuntimeUrlResolver();
  setRuntimeUrlResolver(urls);
  return {
    runtime: { platform: 'web', isDesktop: false, label: 'web' },
  } as RuntimeAPIs;
};

export const createActiveRuntimeUrlResolver = (): RuntimeUrlResolver => ({
  api: (...args) => getRuntimeUrlResolver().api(...args),
  authenticatedAsset: (...args) => getRuntimeUrlResolver().authenticatedAsset(...args),
  auth: (...args) => getRuntimeUrlResolver().auth(...args),
  health: (...args) => getRuntimeUrlResolver().health(...args),
  rawFile: (...args) => getRuntimeUrlResolver().rawFile(...args),
  sse: (...args) => getRuntimeUrlResolver().sse(...args),
  websocket: (...args) => getRuntimeUrlResolver().websocket(...args),
});
