import React from 'react';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { recordMobileDiagnostic } from '@/lib/mobile-error-log';

export const CONFIG_RECONCILIATION_INITIAL_DELAY_MS = 2000;
export const CONFIG_RECONCILIATION_MAX_DELAY_MS = 30000;
const CONFIG_RECONCILIATION_BACKOFF_FACTOR = 2;

export type ConfigStoreReconcilerOptions = {
  getConnection: () => string;
  getIsInitialized: () => boolean;
  getIsConnected: () => boolean;
  initializeApp: () => Promise<void>;
  isDocumentHidden?: () => boolean;
};

/**
 * Shared UI reconciliation for web, desktop (Electron), hosted mobile, and
 * Capacitor mobile: when the authoritative transport is ready (`pi.connection === 'ready'`)
 * but `useConfigStore.isConnected` is false (e.g. after a warm resume where health checks
 * failed transiently while waking), reconcile by re-running `initializeApp()` with paced
 * backoff retry until connected or transport drops. Pauses while hidden; the owning hook
 * calls `wake()` on visibility and network return.
 */
export class ConfigStoreReconciler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentDelayMs = CONFIG_RECONCILIATION_INITIAL_DELAY_MS;
  private inFlight = false;
  private disposed = false;

  constructor(private readonly options: ConfigStoreReconcilerOptions) {}

  get isRunning(): boolean {
    return this.inFlight || this.timer !== null;
  }

  get currentBackoffDelayMs(): number {
    return this.currentDelayMs;
  }

  private isMismatched(): boolean {
    return this.options.getConnection() === 'ready'
      && (!this.options.getIsInitialized() || !this.options.getIsConnected());
  }

  private isHidden(): boolean {
    if (this.options.isDocumentHidden) return this.options.isDocumentHidden();
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private resetDelay(): void {
    this.currentDelayMs = CONFIG_RECONCILIATION_INITIAL_DELAY_MS;
  }

  /** Start an attempt if mismatched and idle; never cuts a pending backoff short. */
  reconcile(): void {
    this.check(false);
  }

  /** Visibility/network return: retry immediately, skipping any pending backoff. */
  wake(): void {
    this.check(true);
  }

  private check(immediate: boolean): void {
    if (this.disposed) return;
    if (!this.isMismatched()) {
      this.clearTimer();
      this.resetDelay();
      return;
    }
    if (this.isHidden()) {
      this.clearTimer();
      return;
    }
    if (!immediate && (this.inFlight || this.timer !== null)) return;
    void this.executeAttempt();
  }

  resetForRuntimeSwitch(): void {
    this.clearTimer();
    this.resetDelay();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private async executeAttempt(): Promise<void> {
    this.clearTimer();
    if (this.disposed || this.inFlight) return;
    if (!this.isMismatched()) {
      this.resetDelay();
      return;
    }
    if (this.isHidden()) return;

    this.inFlight = true;
    recordMobileDiagnostic('config-reconcile', { code: 'attempt' });
    try {
      await this.options.initializeApp();
    } catch {
      // initializeApp handles its own errors; a throw is just a failed attempt.
    } finally {
      this.inFlight = false;
    }
    if (this.disposed) return;

    if (!this.isMismatched()) {
      recordMobileDiagnostic('config-reconcile', { code: 'success' });
      this.resetDelay();
      return;
    }
    recordMobileDiagnostic('config-reconcile', { code: 'failure' });
    if (this.isHidden()) return;

    const delay = this.currentDelayMs;
    this.currentDelayMs = Math.min(delay * CONFIG_RECONCILIATION_BACKOFF_FACTOR, CONFIG_RECONCILIATION_MAX_DELAY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.executeAttempt();
    }, delay);
  }
}

export function useConfigStoreReconciliation({
  connection,
  isInitialized,
  isConnected,
  initializeApp,
}: {
  connection: string;
  isInitialized: boolean;
  isConnected: boolean;
  initializeApp: () => Promise<void>;
}): void {
  const latestRef = React.useRef({
    connection,
    isInitialized,
    isConnected,
    initializeApp,
  });
  latestRef.current = {
    connection,
    isInitialized,
    isConnected,
    initializeApp,
  };

  const reconcilerRef = React.useRef<ConfigStoreReconciler | null>(null);

  React.useEffect(() => {
    reconcilerRef.current?.reconcile();
  }, [connection, isInitialized, isConnected]);

  React.useEffect(() => {
    // Created per effect mount (not during render) so a Strict Mode
    // unmount/remount gets a live reconciler instead of a disposed one.
    const reconciler = new ConfigStoreReconciler({
      getConnection: () => latestRef.current.connection,
      getIsInitialized: () => latestRef.current.isInitialized,
      getIsConnected: () => latestRef.current.isConnected,
      initializeApp: () => latestRef.current.initializeApp(),
    });
    reconcilerRef.current = reconciler;
    reconciler.reconcile();

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        reconciler.wake();
      } else {
        reconciler.reconcile();
      }
    };
    const handleOnline = () => {
      reconciler.wake();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
    }
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      reconciler.resetForRuntimeSwitch();
      reconciler.reconcile();
    });

    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
      }
      unsubscribeRuntime();
      reconciler.dispose();
      if (reconcilerRef.current === reconciler) reconcilerRef.current = null;
    };
  }, []);
}
