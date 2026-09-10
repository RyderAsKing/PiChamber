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

test('Send now records a persisted attempt before delivery', () => {
  const attemptAt = source.indexOf('markDeliveryAttempt(capturedTarget, claimedFollowUp.id, "steer")');
  const deliveryAt = source.indexOf('delivery: "steer"', attemptAt);

  expect(attemptAt).toBeGreaterThan(-1);
  expect(deliveryAt).toBeGreaterThan(attemptAt);
});
