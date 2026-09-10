import { beforeEach, describe, expect, test } from 'bun:test';
import { piClient } from '@/lib/pi/client';
import type { PiSendReceiptResult } from '@/lib/pi/protocol';
import {
  createMessageQueueTarget,
  getMessageQueueKey,
  useMessageQueueStore,
} from './messageQueueStore';
import {
  isQueuedSendUnconfirmedError,
  queryQueuedSendReceipt,
} from './queuedSendReceipt';
import { PiSendUnconfirmedError } from '@/lib/pi/client';

const target = createMessageQueueTarget('session-1', '/repo', 'runtime-a')!;

beforeEach(() => {
  useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
});

describe('queued send receipt query', () => {
  test('removes the entry only on an accepted receipt', async () => {
    useMessageQueueStore.getState().addToQueue(target, { content: 'first' });
    const [entry] = useMessageQueueStore.getState().getQueueForTarget(target);
    useMessageQueueStore.getState().markDeliveryAttempt(target, entry.id, 'followUp');
    const key = getMessageQueueKey(target);
    const queued = useMessageQueueStore.getState().queuedMessages[key] ?? [];
    const attempt = queued[0]?.deliveryAttempt;
    if (!attempt) throw new Error('expected a persisted delivery attempt');
    expect(attempt.kind).toBe('followUp');

    const original = piClient.getSendReceipt.bind(piClient);
    try {
      piClient.getSendReceipt = (async () => ({ status: 'accepted', receipt: { accepted: true, messageId: 'msg_1' } }) as PiSendReceiptResult) as typeof piClient.getSendReceipt;
      expect(await queryQueuedSendReceipt(target, attempt)).toBe('accepted');
      // Only the caller removes, and only for accepted.
      useMessageQueueStore.getState().completeQueuedSend(target, entry.id);
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(0);

      const heldStatuses: PiSendReceiptResult[] = [
        { status: 'pending' },
        { status: 'expired' },
        { status: 'unknown' },
      ];
      for (const result of heldStatuses) {
        useMessageQueueStore.getState().addToQueue(target, { content: 'held' });
        const [held] = useMessageQueueStore.getState().getQueueForTarget(target);
        useMessageQueueStore.getState().markDeliveryAttempt(target, held.id, 'followUp');
        const heldQueue = useMessageQueueStore.getState().getQueueForTarget(target);
        const heldAttempt = heldQueue[0]?.deliveryAttempt;
        if (!heldAttempt) throw new Error('expected a persisted delivery attempt');;
        piClient.getSendReceipt = (async () => result) as typeof piClient.getSendReceipt;
        const status = await queryQueuedSendReceipt(target, heldAttempt);
        expect(status === 'accepted').toBe(false);
        // Non-accepted states keep the entry visible with no replay.
        expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(1);
        useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
      }
    } finally {
      piClient.getSendReceipt = original as typeof piClient.getSendReceipt;
    }
  });

  test('a throwing receipt query resolves unknown and keeps the entry', async () => {
    useMessageQueueStore.getState().addToQueue(target, { content: 'first' });
    const [entry] = useMessageQueueStore.getState().getQueueForTarget(target);
    useMessageQueueStore.getState().markDeliveryAttempt(target, entry.id, 'steer');
    const storedQueue = useMessageQueueStore.getState().getQueueForTarget(target);
    const attempt = storedQueue[0]?.deliveryAttempt;
    if (!attempt) throw new Error('expected a persisted delivery attempt');
    const original = piClient.getSendReceipt.bind(piClient);
    try {
      piClient.getSendReceipt = (async () => { throw new Error('receipt failed'); }) as typeof piClient.getSendReceipt;
      expect(await queryQueuedSendReceipt(target, attempt)).toBe('unknown');
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(1);
    } finally {
      piClient.getSendReceipt = original as typeof piClient.getSendReceipt;
    }
  });
});

describe('unconfirmed error detection', () => {
  test('matches only the worker-owned error class', () => {
    expect(isQueuedSendUnconfirmedError(new PiSendUnconfirmedError('DAEMON_TIMEOUT'))).toBe(true);
    expect(isQueuedSendUnconfirmedError(new Error('confirmed rejection'))).toBe(false);
    expect(isQueuedSendUnconfirmedError('PiSendUnconfirmedError')).toBe(false);
    expect(isQueuedSendUnconfirmedError(null)).toBe(false);
  });
});
