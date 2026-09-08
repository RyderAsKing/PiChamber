import React from 'react';

/**
 * Mobile composer uncertainty flag.
 *
 * True while a selected native endpoint is temporarily unreachable and
 * recovery is retrying (recovering/exhausted with the endpoint retained).
 * While true the composer must disable unsafe mutations and must not
 * enqueue or replay sends — drafts stay local until the transport is
 * verified healthy again.
 *
 * Explicit disconnect (no endpoint) and auth-invalid (login/repair flow)
 * clear the flag because the composer is unmounted (connect screen) rather
 * than gated. The Pi EventSource lifecycle stays owned by the Pi
 * transport/store; this flag never disposes it.
 */

let uncertain = false;
const listeners = new Set<() => void>();

export const isMobileConnectionUncertain = (): boolean => uncertain;

export const setMobileConnectionUncertain = (value: boolean): void => {
  if (uncertain === value) return;
  uncertain = value;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Listener failure must not break state propagation.
    }
  }
};

const subscribeMobileConnectionUncertain = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useMobileConnectionUncertain = (): boolean =>
  React.useSyncExternalStore(
    subscribeMobileConnectionUncertain,
    isMobileConnectionUncertain,
    isMobileConnectionUncertain,
  );
