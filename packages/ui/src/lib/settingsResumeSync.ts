import { refreshDesktopSettings } from '@/lib/persistence';

let activeStop: (() => void) | null = null;

/**
 * Re-read shared settings whenever this client may have missed a change made
 * by another client of the same server: the page became visible or focused
 * again, or the network came back. `refreshDesktopSettings` owns throttling
 * and the stale-response guards, so every signal can simply call it.
 */
export const startSettingsResumeSync = (): (() => void) => {
  if (typeof window === 'undefined' || typeof document === 'undefined' || activeStop) {
    return () => undefined;
  }

  const refresh = () => {
    if (document.visibilityState === 'hidden') return;
    void refreshDesktopSettings();
  };

  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('visibilitychange', refresh);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('online', refresh);
    if (activeStop === stop) activeStop = null;
  };
  activeStop = stop;
  return stop;
};
