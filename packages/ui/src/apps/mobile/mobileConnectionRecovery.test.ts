import { describe, expect, test } from 'bun:test';

import {
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
  let online = options?.online ?? true;
  let visible = options?.visible ?? true;
  const windowListeners = new Map<string, Set<() => void>>();
  const documentListeners = new Map<string, Set<() => void>>();

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
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
});
