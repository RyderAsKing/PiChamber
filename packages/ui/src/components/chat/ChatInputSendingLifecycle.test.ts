import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'ChatInput.tsx'), 'utf8');

test('new-session pending feedback remains active until prompt acceptance settles', () => {
  const sendStart = source.indexOf('const sendPromise = sendMessage(');
  const cleanupStart = source.indexOf('} finally {', sendStart);

  expect(sendStart).toBeGreaterThan(-1);
  expect(cleanupStart).toBeGreaterThan(sendStart);

  const sendLifecycle = source.slice(sendStart, cleanupStart);
  expect(sendLifecycle).toContain('await sendPromise');
  expect(sendLifecycle).toContain('.then(');
  expect(sendLifecycle).not.toContain('void sendPromise.then(');
});

test('worktree send queues in the background with a toast and a fresh draft', () => {
  const requestStart = source.indexOf('const worktreeRequest = draftWorktreeCreation.request(');
  expect(requestStart).toBeGreaterThan(-1);

  const queuedToast = source.indexOf("'Worktree queued'", requestStart);
  expect(queuedToast).toBeGreaterThan(requestStart);

  const freshDraft = source.indexOf('openNewSessionDraft()', queuedToast);
  expect(freshDraft).toBeGreaterThan(queuedToast);

  const awaitRequest = source.indexOf('await worktreeRequest', freshDraft);
  expect(awaitRequest).toBeGreaterThan(freshDraft);
});

test('background worktree failure surfaces a toast when the draft is no longer current', () => {
  expect(source).toContain("'Worktree creation failed'");
});

test('uncertain mobile transport blocks sends, queueing, and the send affordance', () => {
  // Imperative submit gate: the actual ChatInput (not just the app shell)
  // must refuse to replay a mutation into an unverified endpoint.
  expect(source).toContain('isMobileConnectionUncertain()');
  const submitGate = source.indexOf('if (isMobileConnectionUncertain())');
  expect(submitGate).toBeGreaterThan(-1);
  expect(source.slice(submitGate, submitGate + 400)).toContain('Connection lost.');

  // Queue gate: enqueueing while uncertain is also blocked (draft stays local).
  const queueGate = source.indexOf('const handleQueueMessage =');
  expect(queueGate).toBeGreaterThan(-1);
  const queueBody = source.slice(queueGate, queueGate + 800);
  expect(queueBody).toContain('isMobileConnectionUncertain()');

  // Reactive affordance gate: the send/queue buttons disable while uncertain
  // (typing stays enabled so drafts remain local).
  expect(source).toContain('useMobileConnectionUncertain()');
  expect(source).toContain('!isConnectionUncertain');
});
