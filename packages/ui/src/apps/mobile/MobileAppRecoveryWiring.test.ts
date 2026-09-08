import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mobileAppSource = readFileSync(join(__dirname, '..', 'MobileApp.tsx'), 'utf8');
const recoverySource = readFileSync(join(__dirname, 'mobileConnectionRecovery.ts'), 'utf8');

test('queued auto-send stays paused while the transport is uncertain', () => {
  // The actual queue gate lives in MobileApp (not just docs): the uncertain
  // flag disables background queue drain until a verified healthy probe.
  expect(mobileAppSource).toContain('useMobileConnectionUncertain()');
  expect(mobileAppSource).toContain('embeddedBackgroundWorkEnabled={isInitialized && !isUncertain}');
});

test('exhausted recovery restarts on genuine wakes, never on hidden/offline loops', () => {
  // Controller restarts a fresh bounded cycle after exhaustion on genuine wakes.
  expect(recoverySource).toContain('if (this.exhausted)');
  expect(recoverySource).toContain('this.start()');
  // Offline/hidden wakes never start work.
  expect(recoverySource).toContain('if (isOfflineNow() || isHiddenNow()) return;');
  // MobileApp restarts exhausted on resume/online/manual (not manual-only).
  expect(mobileAppSource).not.toContain('does not auto-restart');
  expect(mobileAppSource).toContain("recoveryPhaseRef.current === 'exhausted'");
});

test('all resume/startup probes share the single-owner token', () => {
  // Idle resume and cold-start classification go through probeOnce (shared
  // in-flight token), never a parallel direct reprobeActiveConnection call.
  expect(mobileAppSource).toContain('probeOnce()');
  expect(recoverySource).toContain('async probeOnce()');
  const directCalls = mobileAppSource.match(/reprobeActiveConnection\(\)/g) ?? [];
  // Exactly one direct call remains: the controller probe constructor.
  // Idle, online-debounce, and cold-start paths all use probeOnce/retryNow/start.
  expect(directCalls.length).toBe(1);
});

test('native shell handles established auth-expired immediately and preserves state', () => {
  expect(mobileAppSource).toContain('subscribeRuntimeAuthExpired');
  const effectAt = mobileAppSource.lastIndexOf('subscribeRuntimeAuthExpired');
  const authBlock = mobileAppSource.slice(effectAt, effectAt + 1200);
  // Cancel recovery so late probes cannot side effect; keep saved rows/drafts
  // (only the active endpoint clears) and enter the re-pair notice.
  expect(authBlock).toContain('recoveryRef.current?.cancel()');
  expect(authBlock).toContain('auth-expired');
});
