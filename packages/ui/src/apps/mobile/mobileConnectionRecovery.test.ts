import { describe, expect, test } from 'bun:test';

import {
  MOBILE_RECOVERY_MAX_ATTEMPTS,
  MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS,
  MobileConnectionRecovery,
  getMobileRecoveryDelay,
  isHiddenNow,
  isOfflineNow,
  type RecoveryProbeOutcome,
} from './mobileConnectionRecovery';
import {
  isMobileConnectionUncertain,
  setMobileConnectionUncertain,
} from './mobileRecoveryStatus';

type WindowStub = {
  listeners: Map<string, Set<() => void>>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  dispatch: (type: string) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

type DocumentStub = {
  listeners: Map<string, Set<() => void>>;
  visibilityState: string;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  dispatchVisibility: (state: string) => void;
};

const installRecoveryHarness = (options?: { online?: boolean; visible?: boolean }) => {
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalDocument = (globalThis as Record<string, unknown>).document;
  const originalNavigator = (globalThis as Record<string, unknown>).navigator;

  let online = options?.online ?? true;
  let visible = options?.visible ?? true;

  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();

  const windowStub: WindowStub = {
    listeners: windowListeners,
    addEventListener: (type, listener) => {
      let set = windowListeners.get(type);
      if (!set) {
        set = new Set();
        windowListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type, listener) => {
      windowListeners.get(type)?.delete(listener);
    },
    dispatch: (type) => {
      for (const listener of [...(windowListeners.get(type) ?? [])]) listener();
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  const documentStub: DocumentStub = {
    listeners: documentListeners,
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener: (type, listener) => {
      let set = documentListeners.get(type);
      if (!set) {
        set = new Set();
        documentListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener: (type, listener) => {
      documentListeners.get(type)?.delete(listener);
    },
    dispatchVisibility: (state) => {
      documentStub.visibilityState = state;
      for (const listener of [...(documentListeners.get('visibilitychange') ?? [])]) listener();
    },
  };

  (globalThis as Record<string, unknown>).window = windowStub;
  (globalThis as Record<string, unknown>).document = documentStub;
  (globalThis as Record<string, unknown>).navigator = {
    get onLine() {
      return online;
    },
  };

  return {
    windowStub,
    documentStub,
    setOnline: (value: boolean) => {
      online = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
      documentStub.visibilityState = value ? 'visible' : 'hidden';
    },
    restore: () => {
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = originalWindow;
      if (originalDocument === undefined) delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = originalDocument;
      if (originalNavigator === undefined) delete (globalThis as Record<string, unknown>).navigator;
      else (globalThis as Record<string, unknown>).navigator = originalNavigator;
    },
  };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('mobile recovery delay policy', () => {
  test('paces foreground retries with bounded backoff', () => {
    expect(getMobileRecoveryDelay(1)).toBe(1_000);
    expect(getMobileRecoveryDelay(2)).toBe(2_000);
    expect(getMobileRecoveryDelay(3)).toBe(4_000);
    expect(getMobileRecoveryDelay(4)).toBe(8_000);
    expect(getMobileRecoveryDelay(5)).toBe(15_000);
    expect(getMobileRecoveryDelay(6)).toBe(30_000);
    expect(getMobileRecoveryDelay(7)).toBe(30_000);
    expect(getMobileRecoveryDelay(8)).toBe(30_000);
    // Bounded: further attempts stay capped, never grow or reset to fast.
    expect(getMobileRecoveryDelay(99)).toBe(30_000);
  });

  test('pauses while offline or hidden with the long cap', () => {
    expect(getMobileRecoveryDelay(1, { offline: true })).toBe(MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS);
    expect(getMobileRecoveryDelay(3, { hidden: true })).toBe(MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS);
    expect(MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS).toBe(60_000);
    expect(MOBILE_RECOVERY_MAX_ATTEMPTS).toBe(8);
  });

  test('offline/hidden classification follows navigator and visibility', () => {
    const harness = installRecoveryHarness({ online: true, visible: true });
    try {
      expect(isOfflineNow()).toBe(false);
      expect(isHiddenNow()).toBe(false);
      harness.setOnline(false);
      expect(isOfflineNow()).toBe(true);
      harness.setOnline(true);
      harness.setVisible(false);
      expect(isHiddenNow()).toBe(true);
    } finally {
      harness.restore();
    }
  });
});

describe('mobile recovery controller', () => {
  test('healthy probe retains the endpoint and stops without clearing stores', async () => {
    const harness = installRecoveryHarness();
    try {
      let healthy: 'switched' | 'unchanged' | null = null;
      let probeCalls = 0;
      const recovery = new MobileConnectionRecovery(
        async () => {
          probeCalls += 1;
          return 'unchanged' as RecoveryProbeOutcome;
        },
        {
          onHealthy: (outcome) => {
            healthy = outcome;
          },
          onAuthExpired: () => {
            throw new Error('must not enter auth flow on healthy');
          },
          onNoConnection: () => {
            throw new Error('must not leave recovery on healthy');
          },
          onExhausted: () => {
            throw new Error('must not exhaust on healthy');
          },
        },
        () => 'runtime-a|https://host-a',
      );
      recovery.start();
      await flushMicrotasks();
      expect(healthy).toBe('unchanged');
      expect(probeCalls).toBe(1);
      expect(recovery.isRunning).toBe(false);
      // Terminal healthy state releases wake listeners/timers (resource cleanup).
      expect(harness.windowStub.listeners.get('online')?.size ?? 0).toBe(0);
      expect(harness.documentStub.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
    } finally {
      harness.restore();
    }
  });

  test('alternate transport success (switched) synchronizes without disconnect', async () => {
    const harness = installRecoveryHarness();
    try {
      let healthy: string | null = null;
      const recovery = new MobileConnectionRecovery(
        async () => 'switched' as RecoveryProbeOutcome,
        {
          onHealthy: (outcome) => {
            healthy = outcome;
          },
          onAuthExpired: () => {
            throw new Error('alternate success must not enter auth flow');
          },
          onNoConnection: () => {
            throw new Error('alternate success must not drop the endpoint');
          },
          onExhausted: () => {
            throw new Error('alternate success must not exhaust');
          },
        },
        () => 'runtime-a|relay://srv',
      );
      recovery.start();
      await flushMicrotasks();
      expect(healthy).toBe('switched');
      expect(recovery.isRunning).toBe(false);
    } finally {
      harness.restore();
    }
  });

  test('auth revoke leaves recovery for the login/repair flow without retry', async () => {
    const harness = installRecoveryHarness();
    try {
      let authExpired = 0;
      let probeCalls = 0;
      const recovery = new MobileConnectionRecovery(
        async () => {
          probeCalls += 1;
          return 'needs-login' as RecoveryProbeOutcome;
        },
        {
          onHealthy: () => {
            throw new Error('auth-invalid must not count as healthy');
          },
          onAuthExpired: () => {
            authExpired += 1;
          },
          onNoConnection: () => {
            throw new Error('auth-invalid is not no-connection');
          },
          onExhausted: () => {
            throw new Error('auth-invalid must not enter bounded network retry');
          },
        },
      );
      recovery.start();
      await flushMicrotasks();
      expect(authExpired).toBe(1);
      expect(probeCalls).toBe(1);
      expect(recovery.isRunning).toBe(false);
      // No further probes after auth-invalid, even on wake signals.
      recovery.retryNow();
      await flushMicrotasks();
      expect(probeCalls).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test('no saved candidate leaves recovery with nothing to retain', async () => {
    const harness = installRecoveryHarness();
    try {
      let noConnection = 0;
      const recovery = new MobileConnectionRecovery(
        async () => 'no-connection' as RecoveryProbeOutcome,
        {
          onHealthy: () => {
            throw new Error('no candidate must not be healthy');
          },
          onAuthExpired: () => {
            throw new Error('no candidate is not auth');
          },
          onNoConnection: () => {
            noConnection += 1;
          },
          onExhausted: () => {
            throw new Error('no candidate must not exhaust');
          },
        },
      );
      recovery.start();
      await flushMicrotasks();
      expect(noConnection).toBe(1);
      expect(recovery.isRunning).toBe(false);
    } finally {
      harness.restore();
    }
  });

  test('unreachable retries with backoff and exhausts bounded without disconnecting itself', async () => {
    const harness = installRecoveryHarness();
    const delays: number[] = [];
    const recovery = new MobileConnectionRecovery(
      async () => 'unreachable' as RecoveryProbeOutcome,
      {
        onHealthy: () => {
          throw new Error('unreachable must not be healthy');
        },
        onAuthExpired: () => {
          throw new Error('unreachable is not auth');
        },
        onNoConnection: () => {
          throw new Error('unreachable must retain the endpoint');
        },
        onExhausted: () => undefined,
        onAttempt: (_attempt, delayMs) => {
          delays.push(delayMs);
        },
      },
    );
    try {
      let exhausted = 0;
      const tracked = new MobileConnectionRecovery(
        async () => 'unreachable' as RecoveryProbeOutcome,
        {
          onHealthy: () => {
            throw new Error('unreachable must not be healthy');
          },
          onAuthExpired: () => {
            throw new Error('unreachable is not auth');
          },
          onNoConnection: () => {
            throw new Error('unreachable must retain');
          },
          onExhausted: () => {
            exhausted += 1;
          },
          onAttempt: (_attempt, delayMs) => {
            delays.push(delayMs);
          },
        },
      );
      void recovery;
      tracked.start();
      // Drive the bounded cycle manually: each retryNow shortens the wait
      // without consuming an extra attempt, so 8 unreachable probes exhaust.
      // Guard with isRunning: a retryNow after exhaustion restarts a fresh
      // cycle for a genuine wake (long-outage wake), which must not run here.
      for (let i = 0; i < MOBILE_RECOVERY_MAX_ATTEMPTS; i += 1) {
        await flushMicrotasks();
        if (tracked.isRunning) tracked.retryNow();
      }
      await flushMicrotasks();
      expect(exhausted).toBe(1);
      expect(tracked.isRunning).toBe(false);
      expect(tracked.currentAttempt).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);
      // Foreground pacing was observed (bounded backoff, not constant).
      // 8 probes use 7 waits: 1s, 2s, 4s, 8s, 15s, 30s, 30s.
      expect(delays.length).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS - 1);
      expect(delays[0]).toBe(1_000);
    } finally {
      harness.restore();
    }
  });

  test('delayed wifi: offline holds without burning attempts, online wakes', async () => {
    const harness = installRecoveryHarness({ online: false, visible: true });
    try {
      let probeCalls = 0;
      const delays: number[] = [];
      const recovery = new MobileConnectionRecovery(
        async () => {
          probeCalls += 1;
          return 'unreachable' as RecoveryProbeOutcome;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
          onAttempt: (_attempt, delayMs) => {
            delays.push(delayMs);
          },
        },
      );
      recovery.start();
      await flushMicrotasks();
      // Offline holds: no probe against a known-dead network, no attempt burned.
      expect(probeCalls).toBe(0);
      expect(recovery.currentAttempt).toBe(0);
      expect(recovery.isRunning).toBe(true);
      expect(delays[0]).toBe(MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS);

      // Delayed wifi comes up: online wakes the paused cycle and probes.
      harness.setOnline(true);
      harness.windowStub.dispatch('online');
      await flushMicrotasks();
      expect(probeCalls).toBe(1);
    } finally {
      harness.restore();
    }
  });

  test('hidden pauses, resume/visible wakes without losing the endpoint', async () => {
    const harness = installRecoveryHarness({ online: true, visible: false });
    try {
      let probeCalls = 0;
      const recovery = new MobileConnectionRecovery(
        async () => {
          probeCalls += 1;
          return 'unreachable' as RecoveryProbeOutcome;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      recovery.start();
      await flushMicrotasks();
      expect(probeCalls).toBe(0);
      expect(recovery.isRunning).toBe(true);

      harness.setVisible(true);
      harness.documentStub.dispatchVisibility('visible');
      await flushMicrotasks();
      expect(probeCalls).toBe(1);

      // Manual wake while foreground re-probes (does not consume an attempt).
      const before = recovery.currentAttempt;
      recovery.retryNow();
      await flushMicrotasks();
      expect(probeCalls).toBe(2);
      expect(recovery.currentAttempt).toBeGreaterThanOrEqual(before);
    } finally {
      harness.restore();
    }
  });

  test('rapid duplicates collapse into one probe per generation', async () => {
    const harness = installRecoveryHarness();
    try {
      let probeCalls = 0;
      const gate = deferred<RecoveryProbeOutcome>();
      const recovery = new MobileConnectionRecovery(
        () => {
          probeCalls += 1;
          return gate.promise;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      recovery.start();
      // Two rapid wakes while the first probe is still pending dedup to one.
      recovery.retryNow();
      recovery.retryNow();
      await flushMicrotasks(2);
      expect(probeCalls).toBe(1);
      gate.resolve('unchanged');
      await flushMicrotasks();
      expect(probeCalls).toBe(1);
      expect(recovery.isRunning).toBe(false);
    } finally {
      harness.restore();
    }
  });

  test('explicit disconnect pending rejects the late probe (no late disconnect)', async () => {
    const harness = installRecoveryHarness();
    try {
      let healthy = 0;
      let exhausted = 0;
      const gate = deferred<RecoveryProbeOutcome>();
      const recovery = new MobileConnectionRecovery(
        () => gate.promise,
        {
          onHealthy: () => {
            healthy += 1;
          },
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => {
            exhausted += 1;
          },
        },
      );
      recovery.start();
      await flushMicrotasks(2);
      // User picks another server while the probe is pending: cancel bumps
      // the generation so the late completion commits nothing.
      recovery.cancel();
      gate.resolve('unchanged');
      await flushMicrotasks();
      expect(healthy).toBe(0);
      expect(exhausted).toBe(0);
      expect(recovery.isRunning).toBe(false);
      // Wake after cancel does nothing (resource cleanup verified).
      recovery.retryNow();
      await flushMicrotasks();
      expect(healthy).toBe(0);
    } finally {
      harness.restore();
    }
  });

  test('pending probe for another host commits nothing after an instance switch', async () => {
    const harness = installRecoveryHarness();
    try {
      let healthy: string | null = null;
      let currentIdentity = 'runtime-a|https://host-a';
      const gate = deferred<RecoveryProbeOutcome>();
      const recovery = new MobileConnectionRecovery(
        () => gate.promise,
        {
          onHealthy: (outcome) => {
            healthy = outcome;
          },
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
        () => currentIdentity,
      );
      recovery.start();
      await flushMicrotasks(2);
      // Instance switch mid-probe: identity changes before completion.
      currentIdentity = 'runtime-b|https://host-b';
      gate.resolve('switched');
      await flushMicrotasks();
      expect(healthy).toBeNull();
    } finally {
      harness.restore();
    }
  });

  test('startup and lifecycle starts dedup via generation (late start wins)', async () => {
    const harness = installRecoveryHarness();
    try {
      const seen: string[] = [];
      const first = deferred<RecoveryProbeOutcome>();
      const second = deferred<RecoveryProbeOutcome>();
      let calls = 0;
      const recovery = new MobileConnectionRecovery(
        () => {
          calls += 1;
          return calls === 1 ? first.promise : second.promise;
        },
        {
          onHealthy: (outcome) => {
            seen.push(outcome);
          },
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      recovery.start();
      await flushMicrotasks(2);
      // Lifecycle (resume) restarts while startup probe is pending: new
      // generation supersedes; only the latest completion commits.
      recovery.start();
      await flushMicrotasks(2);
      expect(calls).toBe(2);
      first.resolve('unchanged');
      await flushMicrotasks();
      expect(seen).toEqual([]);
      second.resolve('switched');
      await flushMicrotasks();
      expect(seen).toEqual(['switched']);
    } finally {
      harness.restore();
    }
  });

  test('cancel releases timers and wake listeners (resource cleanup)', async () => {
    const harness = installRecoveryHarness();
    try {
      let probeCalls = 0;
      const recovery = new MobileConnectionRecovery(
        async () => {
          probeCalls += 1;
          return 'unreachable' as RecoveryProbeOutcome;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      recovery.start();
      await flushMicrotasks();
      expect(recovery.isRunning).toBe(true);
      // A backoff wait is scheduled with wake listeners installed.
      expect(harness.windowStub.listeners.get('online')?.size ?? 0).toBe(1);
      recovery.cancel();
      expect(recovery.isRunning).toBe(false);
      expect(harness.windowStub.listeners.get('online')?.size ?? 0).toBe(0);
      expect(harness.documentStub.listeners.get('visibilitychange')?.size ?? 0).toBe(0);
      harness.windowStub.dispatch('online');
      harness.documentStub.dispatchVisibility('visible');
      await flushMicrotasks();
      const after = probeCalls;
      await flushMicrotasks();
      expect(probeCalls).toBe(after);
    } finally {
      harness.restore();
    }
  });

  test('probe throw is treated as unreachable, never as healthy or auth', async () => {
    const harness = installRecoveryHarness();
    try {
      let attempts = 0;
      const recovery = new MobileConnectionRecovery(
        async () => {
          throw new Error('network down');
        },
        {
          onHealthy: () => {
            throw new Error('throw must not be healthy');
          },
          onAuthExpired: () => {
            throw new Error('throw must not be auth');
          },
          onNoConnection: () => {
            throw new Error('throw must retain');
          },
          onExhausted: () => undefined,
          onAttempt: () => {
            attempts += 1;
          },
        },
      );
      recovery.start();
      await flushMicrotasks();
      expect(attempts).toBe(1);
      expect(recovery.isRunning).toBe(true);
      expect(recovery.currentAttempt).toBe(1);
      recovery.cancel();
    } finally {
      harness.restore();
    }
  });
});

describe('mobile recovery uncertainty flag', () => {
  test('composer gate defaults to certain and toggles explicitly', () => {
    setMobileConnectionUncertain(false);
    expect(isMobileConnectionUncertain()).toBe(false);
    setMobileConnectionUncertain(true);
    expect(isMobileConnectionUncertain()).toBe(true);
    setMobileConnectionUncertain(false);
    expect(isMobileConnectionUncertain()).toBe(false);
  });
});

describe('mobile recovery exhausted wake', () => {
  test('genuine online wake after exhaustion restarts a fresh bounded cycle', async () => {
    const harness = installRecoveryHarness();
    try {
      let probes = 0;
      let exhausted = 0;
      let healthy: string | null = null;
      const recovery = new MobileConnectionRecovery(
        async () => {
          probes += 1;
          return 'unreachable' as RecoveryProbeOutcome;
        },
        {
          onHealthy: (outcome) => {
            healthy = outcome;
          },
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => {
            exhausted += 1;
          },
        },
      );
      recovery.start();
      for (let i = 0; i < MOBILE_RECOVERY_MAX_ATTEMPTS; i += 1) {
        await flushMicrotasks();
        if (recovery.isRunning) recovery.retryNow();
      }
      await flushMicrotasks();
      expect(exhausted).toBe(1);
      expect(recovery.isRunning).toBe(false);
      expect(recovery.currentAttempt).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);
      const probesAfterExhaust = probes;

      // Genuine foreground wake restarts fresh: attempt count resets and a
      // new probe runs immediately instead of dead-ending.
      recovery.retryNow();
      await flushMicrotasks();
      expect(recovery.isRunning).toBe(true);
      expect(probes).toBe(probesAfterExhaust + 1);
      expect(healthy).toBeNull();
      recovery.cancel();
    } finally {
      harness.restore();
    }
  });

  test('exhausted wake while offline/hidden never starts a loop', async () => {
    const harness = installRecoveryHarness();
    try {
      let probes = 0;
      const recovery = new MobileConnectionRecovery(
        async () => {
          probes += 1;
          return 'unreachable' as RecoveryProbeOutcome;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      recovery.start();
      for (let i = 0; i < MOBILE_RECOVERY_MAX_ATTEMPTS; i += 1) {
        await flushMicrotasks();
        if (recovery.isRunning) recovery.retryNow();
      }
      await flushMicrotasks();
      expect(recovery.isRunning).toBe(false);
      const atExhaust = probes;
      expect(atExhaust).toBeGreaterThan(0);

      // Offline wake: must not probe or restart.
      harness.setOnline(false);
      recovery.retryNow();
      await flushMicrotasks();
      expect(probes).toBe(atExhaust);
      expect(recovery.isRunning).toBe(false);

      // Hidden wake: must not probe or restart either.
      harness.setOnline(true);
      harness.setVisible(false);
      recovery.retryNow();
      await flushMicrotasks();
      expect(probes).toBe(atExhaust);
      expect(recovery.isRunning).toBe(false);

      // Genuine foreground wake restarts.
      harness.setVisible(true);
      recovery.retryNow();
      await flushMicrotasks();
      expect(probes).toBe(atExhaust + 1);
      recovery.cancel();
    } finally {
      harness.restore();
    }
  });

  test('duplicate exhausted wakes collapse into one fresh probe', async () => {
    const harness = installRecoveryHarness();
    try {
      let probes = 0;
      const gate = deferred<RecoveryProbeOutcome>();
      let calls = 0;
      const recovery = new MobileConnectionRecovery(
        () => {
          calls += 1;
          if (calls <= MOBILE_RECOVERY_MAX_ATTEMPTS) {
            probes += 1;
            return Promise.resolve('unreachable' as RecoveryProbeOutcome);
          }
          probes += 1;
          return gate.promise;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      recovery.start();
      for (let i = 0; i < MOBILE_RECOVERY_MAX_ATTEMPTS; i += 1) {
        await flushMicrotasks();
        if (recovery.isRunning) recovery.retryNow();
      }
      await flushMicrotasks();
      expect(recovery.isRunning).toBe(false);
      const before = probes;
      // Two duplicate genuine wakes: first restarts, second dedups into it.
      recovery.retryNow();
      recovery.retryNow();
      await flushMicrotasks(2);
      expect(probes).toBe(before + 1);
      gate.resolve('unchanged');
      await flushMicrotasks();
      recovery.cancel();
    } finally {
      harness.restore();
    }
  });
});

describe('mobile recovery single-owner idle probe', () => {
  test('idle probeOnce returns the outcome and shares no parallel probe', async () => {
    const harness = installRecoveryHarness();
    try {
      let probes = 0;
      const recovery = new MobileConnectionRecovery(
        async () => {
          probes += 1;
          return 'unchanged' as RecoveryProbeOutcome;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      const outcome = await recovery.probeOnce();
      expect(outcome).toBe('unchanged');
      expect(probes).toBe(1);
      recovery.cancel();
    } finally {
      harness.restore();
    }
  });

  test('duplicate idle probes collapse: second returns null while first is in flight', async () => {
    const harness = installRecoveryHarness();
    try {
      let probes = 0;
      const gate = deferred<RecoveryProbeOutcome>();
      const recovery = new MobileConnectionRecovery(
        () => {
          probes += 1;
          return gate.promise;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      const first = recovery.probeOnce();
      const second = await recovery.probeOnce();
      expect(second).toBeNull();
      expect(probes).toBe(1);
      gate.resolve('switched');
      expect(await first).toBe('switched');
      recovery.cancel();
    } finally {
      harness.restore();
    }
  });

  test('probeOnce returns null while a recovery cycle owns the outcome', async () => {
    const harness = installRecoveryHarness();
    try {
      const gate = deferred<RecoveryProbeOutcome>();
      const recovery = new MobileConnectionRecovery(
        () => gate.promise,
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      recovery.start();
      await flushMicrotasks(2);
      expect(await recovery.probeOnce()).toBeNull();
      gate.resolve('unchanged');
      await flushMicrotasks();
      recovery.cancel();
    } finally {
      harness.restore();
    }
  });

  test('probeOnce returns null offline/hidden without burning a probe', async () => {
    const harness = installRecoveryHarness({ online: false, visible: true });
    try {
      let probes = 0;
      const recovery = new MobileConnectionRecovery(
        async () => {
          probes += 1;
          return 'unchanged' as RecoveryProbeOutcome;
        },
        {
          onHealthy: () => undefined,
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      expect(await recovery.probeOnce()).toBeNull();
      expect(probes).toBe(0);
      harness.setOnline(true);
      harness.setVisible(false);
      expect(await recovery.probeOnce()).toBeNull();
      expect(probes).toBe(0);
      recovery.cancel();
    } finally {
      harness.restore();
    }
  });

  test('probeOnce after disconnect commits nothing (late side effect rejected)', async () => {
    const harness = installRecoveryHarness();
    try {
      const gate = deferred<RecoveryProbeOutcome>();
      let healthy = 0;
      const recovery = new MobileConnectionRecovery(
        () => gate.promise,
        {
          onHealthy: () => {
            healthy += 1;
          },
          onAuthExpired: () => undefined,
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      const pending = recovery.probeOnce();
      recovery.cancel();
      gate.resolve('unchanged');
      expect(await pending).toBeNull();
      expect(healthy).toBe(0);
    } finally {
      harness.restore();
    }
  });

  test('auth event while recovering cancels and the late probe commits nothing', async () => {
    const harness = installRecoveryHarness();
    try {
      let healthy = 0;
      let authExpired = 0;
      const gate = deferred<RecoveryProbeOutcome>();
      const recovery = new MobileConnectionRecovery(
        () => gate.promise,
        {
          onHealthy: () => {
            healthy += 1;
          },
          onAuthExpired: () => {
            authExpired += 1;
          },
          onNoConnection: () => undefined,
          onExhausted: () => undefined,
        },
      );
      recovery.start();
      await flushMicrotasks(2);
      // Established auth-expired flow: cancel recovery immediately (drafts and
      // saved credentials stay; only the cycle stops). The late probe then
      // resolves healthy but must commit nothing.
      recovery.cancel();
      gate.resolve('unchanged');
      await flushMicrotasks();
      expect(healthy).toBe(0);
      expect(authExpired).toBe(0);
      expect(recovery.isRunning).toBe(false);
      recovery.retryNow();
      await flushMicrotasks();
      expect(healthy).toBe(0);
    } finally {
      harness.restore();
    }
  });
});
