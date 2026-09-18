import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(__dirname, 'ChatInput.tsx'), 'utf8');

test('follow-up Send now claims atomically before any await', () => {
  const claimAt = source.indexOf('claimQueuedMessage');
  const submitAt = source.indexOf('const handleSubmit = async');
  const firstAwait = source.indexOf('await new Promise', submitAt);

  expect(submitAt).toBeGreaterThan(-1);
  expect(claimAt).toBeGreaterThan(submitAt);
  expect(firstAwait).toBeGreaterThan(claimAt);
});

test('worktree send captures attachments before the creation await', () => {
  const captureAt = source.indexOf('captureWorktreeAttachments(attachedFiles)');
  const awaitAt = source.indexOf('await worktreeRequest');

  expect(captureAt).toBeGreaterThan(-1);
  expect(awaitAt).toBeGreaterThan(captureAt);
});

test('post-await worktree dispatch and detach use the captured snapshot, not live draft state', () => {
  expect(source).toContain('resolveWorktreeSendAttachments(');
  expect(source).toContain('worktreeSendAttachmentIds(');
  // The composer assembly and detach scope must not read bare live state
  // after the worktree await: files can be stashed, replaced, or expired by
  // then, and newer-draft files must survive a successful dispatch.
  expect(source).not.toContain('composerAttachments: attachedFiles,');
  expect(source).not.toContain('const composerAttachmentIds = attachedFiles.map(');
});

test('post-receipt prompt failure restores captured mentions, not the cleared ref', () => {
  const failureAt = source.indexOf('Message send failed');
  expect(failureAt).toBeGreaterThan(-1);
  // The ref was cleared before the worktree await, so the post-receipt
  // failure path must restore the captured set (as the worktree-creation
  // failure path does) instead of persisting the empty live ref.
  const refRestoreAt = source.indexOf(
    'confirmedMentionsRef.current = confirmedMentionsAtSend',
    failureAt,
  );
  expect(refRestoreAt).toBeGreaterThan(failureAt);
  const draftWriteAt = source.indexOf(
    'confirmedMentionsAtSend ?? confirmedMentionsRef.current',
    failureAt,
  );
  expect(draftWriteAt).toBeGreaterThan(failureAt);
});

test('Send now records a persisted attempt before delivery', () => {
  const attemptAt = source.indexOf('markDeliveryAttempt(capturedTarget, claimedFollowUp.id, "steer")');
  const deliveryAt = source.indexOf('delivery: "steer"', attemptAt);

  expect(attemptAt).toBeGreaterThan(-1);
  expect(deliveryAt).toBeGreaterThan(attemptAt);
});
