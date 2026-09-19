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

test('queueing a worktree send removes its captured attachment cards immediately', () => {
  const requestAt = source.indexOf('const worktreeRequest = draftWorktreeCreation.request({');
  const queuedAt = source.indexOf("toast.info('Worktree queued'", requestAt);
  const awaitAt = source.indexOf('await worktreeRequest', requestAt);
  const detachAt = source.indexOf(
    'detachAttachedFiles(worktreeAttachmentsAtSend.map((file) => file.id))',
    requestAt,
  );

  expect(requestAt).toBeGreaterThan(-1);
  expect(detachAt).toBeGreaterThan(requestAt);
  expect(detachAt).toBeLessThan(queuedAt);
  expect(detachAt).toBeLessThan(awaitAt);
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

test('worktree receipt retains the snapshot until prompt dispatch settles', () => {
  // The task-owned snapshot must survive receipt while materialization and
  // prompt dispatch are pending. The call-site captures the exact generation
  // and settles it by identity, so a late result never clears a newer task.
  expect(source).toContain('worktreeFailedSendAtReceipt');
  expect(source).toContain('getEntryByKey(worktreeTaskKey)?.failedSend');
  expect(source).toContain('markWorktreePromptSucceeded(worktreeTaskKey, worktreeFailedSendAtReceipt)');
  expect(source).toContain('markWorktreePromptFailed(worktreeTaskKey, worktreeFailedSendAtReceipt');
});

test('post-receipt prompt failure transitions the same task without relying on draft currency', () => {
  const failureAt = source.indexOf('markWorktreePromptFailed(worktreeTaskKey');
  expect(failureAt).toBeGreaterThan(-1);
  // Explicit failed-send recovery keeps Restore draft available after draft
  // rotation/navigation; it must not be gated on the submitted draft still
  // being current.
  expect(source.slice(failureAt, failureAt + 500)).toContain('Your prompt was kept in Background tasks. Use Restore draft to retry.');
  const legacyRestoreAt = source.indexOf('if (submittedDraftIsCurrent() && worktreeAttachmentsAtSend)', failureAt);
  expect(legacyRestoreAt).toBeGreaterThan(failureAt);
});

test('attachment recovery is transactional with shared actionable copy', () => {
  expect(source).toContain('describeWorktreeAttachmentLimit');
  expect(source).toContain("describeWorktreeRestoreFailure(result, 'pending-composer')");
  // Every legacy restore call must observe the typed result; overflow never
  // silently drops files when task-owned recovery is unavailable.
  expect(source).toContain('restoreAttachmentsForRetry(worktreeAttachmentsAtSend)');
  expect(source).toContain('if (!restored.ok)');
});

test('worktree send retains the failed prompt in task state instead of dropping it after draft rotation', () => {
  // The composer clears the submitted prompt and rotates the draft id before
  // awaiting creation. The failure path must consult the retained store
  // snapshot (`failedSend`) and keep the prompt in Background tasks instead
  // of silently dropping it when the submitted draft is no longer current.
  // Call-site fidelity: the exact submitted text, captured mentions, and
  // captured attachment snapshot travel with the background task.
  expect(source).toContain('prompt: inputSnapshot.message');
  expect(source).toContain('failedSend: {');
  expect(source).toContain('confirmedMentionsAtSend');
  expect(source).toContain('attachments: worktreeAttachmentsAtSend');

  const requestAt = source.indexOf('draftWorktreeCreation.request({');
  expect(requestAt).toBeGreaterThan(-1);
  const failedSendAt = source.indexOf('failedSend: {', requestAt);
  expect(failedSendAt).toBeGreaterThan(requestAt);
  expect(source.slice(failedSendAt, failedSendAt + 400)).toContain('prompt: inputSnapshot.message');
  expect(source.slice(failedSendAt, failedSendAt + 400)).toContain('worktreeAttachmentsAtSend');

  // Recovery fidelity: after the await, the retained entry wins over the
  // legacy same-draft restore. A failed entry with `failedSend` keeps the
  // prompt in Background tasks and returns before any draft-rotation restore.
  const awaitAt = source.indexOf('worktreeCreationReceipt = await worktreeRequest');
  expect(awaitAt).toBeGreaterThan(requestAt);
  const retainedAt = source.indexOf('failedEntry?.failedSend', awaitAt);
  expect(retainedAt).toBeGreaterThan(awaitAt);
  const rotationRestoreAt = source.indexOf('if (submittedDraftIsCurrent())', retainedAt);
  expect(rotationRestoreAt).toBeGreaterThan(retainedAt);
  expect(source.slice(retainedAt, rotationRestoreAt + 200)).toContain('Your prompt was kept in Background tasks');
});
