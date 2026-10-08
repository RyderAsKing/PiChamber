/**
 * Quit-time server-stop coordination for the Electron main process.
 *
 * The in-process PiChamber server owns the Tailscale mapping removal on its
 * stop path. Quitting without awaiting that stop orphans the mapping
 * (tailscaled persists serve config), so every quit path must await the stop
 * with a bounded overall timeout and then exit — quit stays responsive even
 * when the server hangs.
 *
 * Single-flight by construction: concurrent quit signals share one stop
 * promise (no double-stop), and `reset()` re-arms after a fresh server start.
 * Never throws: stop failures resolve (after reporting via `onError`) so the
 * caller always reaches `app.exit`.
 */

export const QUIT_SERVER_STOP_TIMEOUT_MS = 8_000;

export const createQuitServerStop = ({ timeoutMs = QUIT_SERVER_STOP_TIMEOUT_MS, onError } = {}) => {
  let stopPromise = null;

  const requestStop = (handle) => {
    if (stopPromise) return stopPromise;
    if (!handle || typeof handle.stop !== 'function') {
      stopPromise = Promise.resolve({ stopped: false, reason: 'no-handle' });
      return stopPromise;
    }
    stopPromise = (async () => {
      try {
        await Promise.race([
          handle.stop({ exitProcess: false }),
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), timeoutMs);
            if (timer?.unref) timer.unref();
          }),
        ]);
        return { stopped: true };
      } catch (error) {
        try {
          onError?.(error);
        } catch {
        }
        return { stopped: false, error };
      }
    })();
    return stopPromise;
  };

  const reset = () => {
    stopPromise = null;
  };

  return { requestStop, reset };
};
