import { describe, expect, test } from 'bun:test';

import {
  MOBILE_RECOVERY_EXHAUSTED_POLL_MS,
  MOBILE_RECOVERY_MAX_ATTEMPTS,
  MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS,
  MobileConnectionRecovery,
  getMobileRecoveryDelay,
  type RecoveryCallbacks,
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

const installRecoveryHarness = (options?: {
  online?: boolean;
  visible?: boolean;
}) => {
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalDocument = (globalThis as Record<string, unknown>).document;
  const originalNavigator = (globalThis as Record<string, unknown>).navigator;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let online = options?.online ?? true;
  let visible = options?.visible ?? true;
  let virtualTime = 0;
  let nextTimerId = 1;
  const pendingTimers = new Map<number, { callback: () => void; dueTime: number }>();
  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();

  const fakeSetTimeout = (handler: TimerHandler, timeout = 0, ...args: unknown[]) => {
    const id = nextTimerId++;
    const callback =
      typeof handler === 'function'
        ? () => (handler as (...args: unknown[]) => void)(...args)
        : typeof handler === 'string'
          ? () => {
              new Function(handler)();
            }
          : () => {};
    pendingTimers.set(id, { callback, dueTime: virtualTime + Math.max(0, timeout) });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  const fakeClearTimeout = (id: unknown) => {
    pendingTimers.delete(id as number);
  };

  globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;
  globalThis.clearTimeout = fakeClearTimeout as typeof clearTimeout;

  const windowStub: WindowStub = {
    listeners: windowListeners,
    addEventListener: (type, listener) => {
      const listeners = windowListeners.get(type) ?? new Set();
      listeners.add(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener: (type, listener) => {
      windowListeners.get(type)?.delete(listener);
    },
    dispatch: (type) => {
      for (const listener of [...(windowListeners.get(type) ?? [])]) listener();
    },
    setTimeout: fakeSetTimeout as unknown as typeof setTimeout,
    clearTimeout: fakeClearTimeout as typeof clearTimeout,
  };

  const documentStub: DocumentStub = {
    listeners: documentListeners,
    visibilityState: visible ? 'visible' : 'hidden',
    addEventListener: (type, listener) => {
      const listeners = documentListeners.get(type) ?? new Set();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener: (type, listener) => {
      documentListeners.get(type)?.delete(listener);
    },
    dispatchVisibility: (state) => {
      documentStub.visibilityState = state;
      for (const listener of [
        ...(documentListeners.get('visibilitychange') ?? []),
      ]) {
        listener();
      }
    },
  };

  (globalThis as Record<string, unknown>).window = windowStub;
  (globalThis as Record<string, unknown>).document = documentStub;
  (globalThis as Record<string, unknown>).navigator = {
    get onLine() {
      return online;
    },
  };

  const advanceTimersByTime = async (ms: number) => {
    const targetTime = virtualTime + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestDue = Infinity;
      for (const [id, timer] of pendingTimers.entries()) {
        if (timer.dueTime <= targetTime && timer.dueTime < earliestDue) {
          earliestDue = timer.dueTime;
          earliestId = id;
        }
      }
      if (earliestId === null) {
        virtualTime = targetTime;
        break;
      }
      virtualTime = earliestDue;
      const entry = pendingTimers.get(earliestId);
      pendingTimers.delete(earliestId);
      entry?.callback();
      await flush();
    }
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
    advanceTimersByTime,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      if (originalWindow === undefined)
        delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = originalWindow;
      if (originalDocument === undefined)
        delete (globalThis as Record<string, unknown>).document;
      else (globalThis as Record<string, unknown>).document = originalDocument;
      if (originalNavigator === undefined)
        delete (globalThis as Record<string, unknown>).navigator;
      else (globalThis as Record<string, unknown>).navigator = originalNavigator;
    },
  };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
  }
};

const callbacks = (
  overrides: Partial<RecoveryCallbacks> = {},
): RecoveryCallbacks => ({
  onHealthy: () => undefined,
  onAuthExpired: () => undefined,
  onNoConnection: () => undefined,
  onExhausted: () => undefined,
  ...overrides,
});

const exhaust = async (recovery: MobileConnectionRecovery) => {
  recovery.start();
  for (let i = 0; i < MOBILE_RECOVERY_MAX_ATTEMPTS; i += 1) {
    await flush();
    if (recovery.isRunning) recovery.retryNow();
  }
  await flush();
};

describe('mobile recovery policy', () => {
  test('uses the eight paced delays and a 60 second offline/hidden cap', () => {
    expect(
      Array.from({ length: MOBILE_RECOVERY_MAX_ATTEMPTS }, (_, index) =>
        getMobileRecoveryDelay(index + 1),
      ),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000]);
    expect(getMobileRecoveryDelay(99)).toBe(30_000);
    expect(getMobileRecoveryDelay(2, { offline: true })).toBe(
      MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS,
    );
    expect(getMobileRecoveryDelay(2, { hidden: true })).toBe(60_000);
  });

  test('exhausts after eight probes and a foreground wake starts a fresh cycle', async () => {
    const harness = installRecoveryHarness();
    let probes = 0;
    let exhaustedCount = 0;
    const scheduledDelays: number[] = [];
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return 'unreachable';
      },
      callbacks({
        onExhausted: () => (exhaustedCount += 1),
        onAttempt: (_attempt, delay) => scheduledDelays.push(delay),
      }),
    );
    try {
      await exhaust(recovery);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);
      expect(scheduledDelays).toEqual([
        1_000,
        2_000,
        4_000,
        8_000,
        15_000,
        30_000,
        30_000,
        30_000,
      ]);
      expect(recovery.currentAttempt).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);
      expect(recovery.isRunning).toBe(false);
      expect(exhaustedCount).toBe(1);

      recovery.retryNow();
      await flush();
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 1);
      expect(recovery.currentAttempt).toBe(1);
      expect(recovery.isRunning).toBe(true);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('offline and hidden states pause without attempts, then wake promptly', async () => {
    const harness = installRecoveryHarness({ online: false });
    let probes = 0;
    const delays: number[] = [];
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return 'unreachable';
      },
      callbacks({ onAttempt: (_attempt, delay) => delays.push(delay) }),
    );
    try {
      recovery.start();
      await flush();
      expect(probes).toBe(0);
      expect(recovery.currentAttempt).toBe(0);
      expect(delays.at(-1)).toBe(60_000);

      harness.setOnline(true);
      harness.windowStub.dispatch('online');
      await flush();
      expect(probes).toBe(1);

      harness.setVisible(false);
      recovery.retryNow();
      await flush();
      expect(probes).toBe(1);
      expect(delays.at(-1)).toBe(60_000);

      harness.setVisible(true);
      harness.documentStub.dispatchVisibility('visible');
      await flush();
      expect(probes).toBe(2);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('auth-invalid exits to repair without entering the retry loop', async () => {
    const harness = installRecoveryHarness();
    let probes = 0;
    let authExpired = 0;
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return 'needs-login';
      },
      callbacks({ onAuthExpired: () => (authExpired += 1) }),
    );
    try {
      recovery.start();
      await flush();
      recovery.retryNow();
      await flush();
      expect(probes).toBe(1);
      expect(authExpired).toBe(1);
      expect(recovery.isRunning).toBe(false);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('cycle and idle callers share one probe owner', async () => {
    const harness = installRecoveryHarness();
    const gate = deferred<RecoveryProbeOutcome>();
    let probes = 0;
    const recovery = new MobileConnectionRecovery(
      () => {
        probes += 1;
        return gate.promise;
      },
      callbacks(),
    );
    try {
      recovery.start();
      recovery.retryNow();
      recovery.retryNow();
      expect(await recovery.probeOnce()).toBeNull();
      expect(probes).toBe(1);
      gate.resolve('unchanged');
      await flush();
      expect(probes).toBe(1);
      expect(recovery.isRunning).toBe(false);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('idle probe rejects a late result after generation or identity changes', async () => {
    const harness = installRecoveryHarness();
    const generationGate = deferred<RecoveryProbeOutcome>();
    let identity = 'runtime-a|https://a.example';
    const recovery = new MobileConnectionRecovery(
      () => generationGate.promise,
      callbacks(),
      () => identity,
    );
    try {
      const cancelled = recovery.probeOnce();
      recovery.cancel();
      generationGate.resolve('unchanged');
      expect(await cancelled).toBeNull();

      const identityGate = deferred<RecoveryProbeOutcome>();
      const identityRecovery = new MobileConnectionRecovery(
        () => identityGate.promise,
        callbacks(),
        () => identity,
      );
      const switched = identityRecovery.probeOnce();
      identity = 'runtime-b|https://b.example';
      identityGate.resolve('switched');
      expect(await switched).toBeNull();
      identityRecovery.cancel();
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('uncertainty state toggles independently of retained composer data', () => {
    setMobileConnectionUncertain(false);
    expect(isMobileConnectionUncertain()).toBe(false);
    setMobileConnectionUncertain(true);
    expect(isMobileConnectionUncertain()).toBe(true);
    setMobileConnectionUncertain(false);
  });

  test('exhausted slow poll probes once after MOBILE_RECOVERY_EXHAUSTED_POLL_MS and calls onHealthy on success', async () => {
    const harness = installRecoveryHarness();
    let probes = 0;
    let exhaustedCount = 0;
    let healthyOutcome: string | null = null;
    let probeOutcome: RecoveryProbeOutcome = 'unreachable';
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return probeOutcome;
      },
      callbacks({
        onExhausted: () => (exhaustedCount += 1),
        onHealthy: (outcome) => {
          healthyOutcome = outcome;
        },
      }),
    );
    try {
      await exhaust(recovery);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);
      expect(exhaustedCount).toBe(1);
      expect(recovery.isRunning).toBe(false);

      probeOutcome = 'unchanged';
      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS);

      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 1);
      expect(healthyOutcome).toBe('unchanged');
      expect(exhaustedCount).toBe(1);
      expect(recovery.isRunning).toBe(false);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('unreachable polls keep polling across intervals without extra onExhausted or onAttempt calls', async () => {
    const harness = installRecoveryHarness();
    let probes = 0;
    let exhaustedCount = 0;
    let attemptCount = 0;
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return 'unreachable';
      },
      callbacks({
        onExhausted: () => (exhaustedCount += 1),
        onAttempt: () => (attemptCount += 1),
      }),
    );
    try {
      await exhaust(recovery);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);
      expect(exhaustedCount).toBe(1);
      const attemptsDuringCycle = attemptCount;
      expect(attemptsDuringCycle).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);

      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 1);
      expect(exhaustedCount).toBe(1);
      expect(attemptCount).toBe(attemptsDuringCycle);

      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 2);
      expect(exhaustedCount).toBe(1);
      expect(attemptCount).toBe(attemptsDuringCycle);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('no probe while hidden or offline at poll time and reschedules', async () => {
    const harness = installRecoveryHarness();
    let probes = 0;
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return 'unreachable';
      },
      callbacks(),
    );
    try {
      await exhaust(recovery);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);

      harness.setOnline(false);
      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);

      harness.setOnline(true);
      harness.setVisible(false);
      await harness.advanceTimersByTime(MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);

      harness.setVisible(true);
      await harness.advanceTimersByTime(MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 1);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('cancel after exhaustion stops polling; retryNow starts a fresh bounded cycle without stray poll fires', async () => {
    const harness = installRecoveryHarness();
    let probes = 0;
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return 'unreachable';
      },
      callbacks(),
    );
    try {
      await exhaust(recovery);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);

      recovery.cancel();
      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS * 2);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);

      await exhaust(recovery);
      const probesAfterSecondExhaust = probes;

      recovery.retryNow();
      await flush();
      expect(probes).toBe(probesAfterSecondExhaust + 1);
      expect(recovery.isRunning).toBe(true);
      expect(recovery.currentAttempt).toBe(1);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('needs-login during an exhausted poll calls onAuthExpired and clears exhausted state', async () => {
    const harness = installRecoveryHarness();
    let probes = 0;
    let authExpired = 0;
    let probeOutcome: RecoveryProbeOutcome = 'unreachable';
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return probeOutcome;
      },
      callbacks({
        onAuthExpired: () => (authExpired += 1),
      }),
    );
    try {
      await exhaust(recovery);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);
      expect(authExpired).toBe(0);

      probeOutcome = 'needs-login';
      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS);

      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 1);
      expect(authExpired).toBe(1);
      expect(recovery.isRunning).toBe(false);

      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 1);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('no-connection during an exhausted poll calls onNoConnection and clears exhausted state', async () => {
    const harness = installRecoveryHarness();
    let probes = 0;
    let noConnectionCount = 0;
    let probeOutcome: RecoveryProbeOutcome = 'unreachable';
    const recovery = new MobileConnectionRecovery(
      async () => {
        probes += 1;
        return probeOutcome;
      },
      callbacks({
        onNoConnection: () => (noConnectionCount += 1),
      }),
    );
    try {
      await exhaust(recovery);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS);
      expect(noConnectionCount).toBe(0);

      probeOutcome = 'no-connection';
      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS);

      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 1);
      expect(noConnectionCount).toBe(1);
      expect(recovery.isRunning).toBe(false);

      await harness.advanceTimersByTime(MOBILE_RECOVERY_EXHAUSTED_POLL_MS);
      expect(probes).toBe(MOBILE_RECOVERY_MAX_ATTEMPTS + 1);
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });

  test('probeOnce returns null while exhausted and waiting for poll', async () => {
    const harness = installRecoveryHarness();
    const recovery = new MobileConnectionRecovery(
      async () => 'unreachable',
      callbacks(),
    );
    try {
      await exhaust(recovery);
      expect(await recovery.probeOnce()).toBeNull();
    } finally {
      recovery.cancel();
      harness.restore();
    }
  });
});
