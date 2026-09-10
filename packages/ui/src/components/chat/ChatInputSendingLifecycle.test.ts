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

// Predictable local follow-up dispatch: atomic claim before awaits, no
// merging of pending follow-ups into normal/steering submits, captured-only
// removals, captured variant without mutable fallback, and Send now steering
// irrespective of stale client idle.
test('follow-up Send now claims atomically before any await', () => {
  expect(source).toContain('claimQueuedMessage');
  const claimAt = source.indexOf('claimQueuedMessage');
  const submitAt = source.indexOf('const handleSubmit = async');
  expect(submitAt).toBeGreaterThan(-1);
  expect(claimAt).toBeGreaterThan(submitAt);
  // The claim must precede the first await in the submit path (race window
  // is seconds over a relay). The new-session paint yield is the first await
  // for new drafts; queued Send now returns before it via the early claim.
  const firstAwait = source.indexOf('await new Promise', submitAt);
  expect(firstAwait).toBeGreaterThan(claimAt);
});

test('normal submit never merges pending follow-ups and never clears them', () => {
  expect(source).not.toContain('queued: queuedMessagesToSend');
  expect(source).not.toContain('clearQueue(capturedTarget)');
});

test('Send now completes only its captured follow-up id', () => {
  expect(source).toContain('completeQueuedSend(capturedTarget, claimed');
  expect(source).not.toContain('removeFromQueue(capturedTarget, claimed');
  expect(source).not.toContain('removeFromQueue(capturedTarget, queuedMessageId)');
});

test('Send now records a persisted attempt before delivery and labels confirmed failures', () => {
  expect(source).toContain('markDeliveryAttempt(capturedTarget, claimedFollowUp.id, "steer")');
  expect(source).toContain('markSendFailed(capturedTarget, claimedFollowUp.id)');
  expect(source).toContain('markSendUnconfirmed(capturedTarget, claimedFollowUp.id, "steer")');
});

test('queued sends carry typed delivery and operationId without casts', () => {
  expect(source).toContain('operationId: claimedFollowUp.id');
  expect(source).not.toContain('as unknown as Parameters<typeof sendMessage>');
});

test('captured follow-up variant never falls back to the mutable current variant', () => {
  expect(source).not.toContain('capturedSendConfig?.variant ?? currentVariant');
});

test('Send now steers irrespective of stale client idle', () => {
  expect(source).not.toContain('options?.delivery === "steer" && sessionPhase');
  expect(source).toContain('delivery: "steer"');
});

test('single Send now ignores unrelated composer draft and uploads', () => {
  // Queued-only sends build from the claimed entry with an empty composer.
  expect(source).toContain('composerAttachments: []');
});
