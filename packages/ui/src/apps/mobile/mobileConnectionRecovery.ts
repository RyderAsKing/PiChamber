/**
 * Mobile connection recovery for temporary unreachable runtimes.
 *
 * Owns the foreground retry policy for a SELECTED saved connection whose
 * endpoint is temporarily unreachable: retain the endpoint, the saved
 * connection row, and all stale content/drafts while retrying in a paced,
 * bounded way. Retries pause while offline/hidden and wake on
 * online/visibility/resume/manual signals.
 *
 * An exhausted cycle (bounded retries gave up, endpoint still retained)
 * restarts as a fresh bounded cycle on a genuine online/foreground/manual
 * wake — a long outage must wake promptly instead of dead-ending until the
 * user restarts the app. Duplicate wakes collapse via the single in-flight
 * probe token; offline/hidden wakes never start a probe loop.
 *
 * Explicit disconnect (user picks another server, deletes the active
 * connection, or clears the endpoint) is distinct: it cancels recovery with
 * no further probes. Auth-invalid (`needs-login`) leaves recovery and enters
 * the established re-pair flow via the caller (connect screen with an
 * auth-expired notice). `no-connection` (current runtime key maps to no saved
 * row) also leaves recovery — there is nothing to retain.
 *
 * Probes reuse `reprobeActiveConnection`, which verifies candidate identity
 * (serverId) and closes unused relay tunnels, so this module never opens raw
 * transports itself. Generation tokens reject late probe completions after an
 * explicit disconnect or host switch. Native `EventSource` recovery stays
 * owned by the Pi transport/store — this module never disposes it on
 * temporary failure.
 */

export type RecoveryProbeOutcome = 'switched' | 'unchanged' | 'unreachable' | 'needs-login' | 'no-connection';

export type RecoveryTerminalState =
  | { kind: 'healthy'; outcome: 'switched' | 'unchanged' }
  | { kind: 'auth-expired' }
  | { kind: 'no-connection' }
  | { kind: 'exhausted' };

export const MOBILE_RECOVERY_MAX_ATTEMPTS = 8;
export const MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS = 60_000;

const BASE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000];

export const getMobileRecoveryDelay = (
  attempt: number,
  options?: { offline?: boolean; hidden?: boolean },
): number => {
  if (options?.offline || options?.hidden) return MOBILE_RECOVERY_OFFLINE_HIDDEN_DELAY_MS;
  if (attempt <= 0) return BASE_DELAYS_MS[0] ?? 1_000;
  const index = Math.min(attempt - 1, BASE_DELAYS_MS.length - 1);
  return BASE_DELAYS_MS[index] ?? 30_000;
};

export const isOfflineNow = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? !navigator.onLine : false;

export const isHiddenNow = (): boolean =>
  typeof document !== 'undefined' && typeof document.visibilityState === 'string'
    ? document.visibilityState === 'hidden'
    : false;

export type RecoveryCallbacks = {
  onHealthy: (outcome: 'switched' | 'unchanged') => void;
  onAuthExpired: () => void;
  onNoConnection: () => void;
  onExhausted: () => void;
  onAttempt?: (attempt: number, delayMs: number) => void;
};

export type ProbeFn = () => Promise<RecoveryProbeOutcome>;

/**
 * Generation-scoped recovery controller. One instance per MobileApp mount;
 * `start()` begins (or restarts) a bounded retry cycle for the CURRENT
 * endpoint, `cancel()` abandons it (explicit disconnect/host switch/unmount),
 * and `retryNow()` wakes it for online/resume/manual signals — including a
 * fresh bounded cycle when a genuine wake arrives after exhaustion.
 *
 * `probeOnce()` is the single-owner idle probe for foreground resume/
 * startup classification: it shares the in-flight probe token with the
 * recovery cycle so parallel `reprobeActiveConnection` calls (and parallel
 * candidate/tunnel switches) cannot happen. It returns `null` when another
 * probe already owns the outcome, when offline/hidden, or when the runtime
 * changed mid-probe.
 *
 * Late probe completions are rejected by generation AND by runtime identity
 * captured at probe start: a disconnect or host switch between probe start
 * and probe end commits nothing.
 */
export class MobileConnectionRecovery {
  private generation = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakeCleanup: (() => void) | null = null;
  private running = false;
  private exhausted = false;
  private probingGeneration: number | null = null;

  constructor(
    private readonly probe: ProbeFn,
    private readonly callbacks: RecoveryCallbacks,
    private readonly getRuntimeIdentity: () => string = () => '',
  ) {}

  get currentGeneration(): number {
    return this.generation;
  }

  get currentAttempt(): number {
    return this.attempt;
  }

  get isRunning(): boolean {
    return this.running && !this.exhausted;
  }

  /** Begin a fresh bounded cycle. Retains the endpoint; never clears stores. */
  start(): void {
    this.clearTimer();
    this.generation += 1;
    this.attempt = 0;
    this.exhausted = false;
    this.running = true;
    void this.runAttempt(this.generation);
  }

  /** Wake a paused/backoff cycle (online, visible, resume, manual retry).
   *
   * A genuine wake after exhaustion restarts a fresh bounded cycle instead
   * of dead-ending: a long outage must wake promptly. Offline/hidden wakes
   * never start work — they hold so no hidden/offline loop can burn the
   * radio. Duplicate wakes while a probe is in flight collapse into that
   * probe via the single owner token.
   */
  retryNow(): void {
    if (this.exhausted) {
      if (isOfflineNow() || isHiddenNow()) return;
      this.start();
      return;
    }
    if (!this.running) return;
    // Dedup rapid duplicates: a probe already in flight for this generation
    // owns the outcome; a second concurrent probe would double-count attempts
    // or double-switch transports.
    if (this.probingGeneration === this.generation) return;
    // Paused offline/hidden: hold instead of burning a probe against a
    // known-dead network. Ensure a long-cap wait is scheduled so the
    // online/visible wake below can fire.
    if (isOfflineNow() || isHiddenNow()) {
      this.clearTimer();
      this.scheduleNext(this.generation);
      return;
    }
    // Manual/online wake does not consume an extra attempt: it shortens the
    // current wait and re-probes immediately.
    this.clearTimer();
    const generation = this.generation;
    void this.runAttempt(generation);
  }

  /** Abandon recovery: explicit disconnect, host switch, or unmount. */
  cancel(): void {
    this.generation += 1;
    this.running = false;
    this.exhausted = false;
    this.attempt = 0;
    this.probingGeneration = null;
    this.clearTimer();
  }

  /**
   * Single-owner idle probe for foreground resume/startup classification.
   *
   * Shares the in-flight probe token with the recovery cycle: while a
   * recovery probe (or another idle probe) is in flight, this returns `null`
   * and the owner commits the outcome — no parallel
   * `reprobeActiveConnection` calls, no parallel candidate/tunnel switching.
   * Returns `null` without probing while offline/hidden, after a runtime
   * switch/disconnect mid-probe, or when a recovery cycle owns the outcome.
   */
  async probeOnce(): Promise<RecoveryProbeOutcome | null> {
    if (this.running || this.exhausted) return null;
    if (this.probingGeneration !== null) return null;
    if (isOfflineNow() || isHiddenNow()) return null;
    const generation = this.generation;
    this.probingGeneration = generation;
    const runtimeBefore = this.getRuntimeIdentity();
    let outcome: RecoveryProbeOutcome;
    try {
      outcome = await this.probe();
    } catch {
      outcome = 'unreachable';
    } finally {
      if (this.probingGeneration === generation) this.probingGeneration = null;
    }
    if (generation !== this.generation) return null;
    if (this.getRuntimeIdentity() !== runtimeBefore) return null;
    return outcome;
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.wakeCleanup) {
      this.wakeCleanup();
      this.wakeCleanup = null;
    }
  }

  private scheduleNext(generation: number): void {
    if (generation !== this.generation || !this.running || this.exhausted) return;
    if (this.attempt >= MOBILE_RECOVERY_MAX_ATTEMPTS) {
      this.exhausted = true;
      this.running = false;
      this.clearTimer();
      this.callbacks.onExhausted();
      return;
    }
    const nextAttempt = this.attempt + 1;
    // Delay paces the UPCOMING probe: after `attempt` failures, wait the
    // `attempt`-th backoff slot (1s, 2s, 4s, … capped at 30s). Offline/hidden
    // always uses the long cap and wakes on signals instead of burning attempts.
    const delay = getMobileRecoveryDelay(this.attempt, { offline: isOfflineNow(), hidden: isHiddenNow() });
    this.callbacks.onAttempt?.(nextAttempt, delay);

    const wake = () => {
      // Pause while offline/hidden: only wake when foreground AND online.
      if (isOfflineNow() || isHiddenNow()) return;
      if (generation !== this.generation) return;
      this.clearTimer();
      void this.runAttempt(generation);
    };
    const onOnline = () => wake();
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') wake();
    };
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    this.wakeCleanup = () => {
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wakeCleanup?.();
      this.wakeCleanup = null;
      if (generation !== this.generation || !this.running || this.exhausted) return;
      // If we slept through an offline/hidden spell, hold instead of burning
      // an attempt against a known-dead network.
      if (isOfflineNow() || isHiddenNow()) {
        this.scheduleNext(generation);
        return;
      }
      void this.runAttempt(generation);
    }, delay);
  }

  private async runAttempt(generation: number): Promise<void> {
    if (generation !== this.generation || !this.running || this.exhausted) return;
    // Dedup concurrent probes for the same generation (rapid online/resume
    // flaps). A fresh generation from start()/cancel() may still probe
    // concurrently with a stale one; the stale result is rejected below by
    // generation + runtime identity.
    if (this.probingGeneration === generation) return;
    // Pause while offline/hidden: hold without burning an attempt or a probe.
    // scheduleNext uses the long cap and installs online/visible wake listeners.
    if (isOfflineNow() || isHiddenNow()) {
      this.scheduleNext(generation);
      return;
    }
    this.probingGeneration = generation;
    const runtimeBefore = this.getRuntimeIdentity();
    let outcome: RecoveryProbeOutcome;
    try {
      outcome = await this.probe();
    } catch {
      outcome = 'unreachable';
    } finally {
      if (this.probingGeneration === generation) this.probingGeneration = null;
    }
    if (generation !== this.generation) return;
    // Host switch or explicit disconnect mid-probe: the endpoint this probe
    // validated is no longer current — commit nothing.
    if (this.getRuntimeIdentity() !== runtimeBefore) return;

    if (outcome === 'switched' || outcome === 'unchanged') {
      this.running = false;
      this.clearTimer();
      this.callbacks.onHealthy(outcome);
      return;
    }
    if (outcome === 'needs-login') {
      this.running = false;
      this.clearTimer();
      this.callbacks.onAuthExpired();
      return;
    }
    if (outcome === 'no-connection') {
      this.running = false;
      this.clearTimer();
      this.callbacks.onNoConnection();
      return;
    }
    // 'unreachable': count the failure and back off. Foreground-paced,
    // bounded; offline/hidden uses the long cap and wakes on signals.
    this.attempt += 1;
    this.scheduleNext(generation);
  }
}
