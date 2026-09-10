import { PiSendUnconfirmedError, piClient } from '@/lib/pi/client';
import type { MessageQueueTarget, QueuedDeliveryAttempt } from './messageQueueStore';

/** Receipt outcome for a persisted uncertain delivery attempt. */
type QueuedReceiptStatus = 'accepted' | 'pending' | 'expired' | 'unknown';

const normalizeReceiptStatus = (result: unknown): QueuedReceiptStatus => {
  if (!result || typeof result !== 'object') return 'unknown';
  const record = result as Record<string, unknown>;
  if (record.status === 'accepted') {
    const receipt = record.receipt as Record<string, unknown> | undefined;
    if (receipt?.accepted === true && typeof receipt.messageId === 'string') {
      return 'accepted';
    }
    return 'unknown';
  }
  if (record.status === 'pending') return 'pending';
  if (record.status === 'expired') return 'expired';
  if (record.status === 'unknown') return 'unknown';
  return 'unknown';
};

/**
 * Read-only delivery receipt check. Never sends, never replays, never mutates
 * the queue — callers decide whether an `accepted` receipt may remove the
 * entry. All other states keep the entry visible. Resolves `unknown` when the
 * query fails.
 */
export const queryQueuedSendReceipt = async (
  target: MessageQueueTarget,
  attempt: QueuedDeliveryAttempt,
): Promise<QueuedReceiptStatus> => {
  try {
    const result = await piClient.getSendReceipt({
      sessionId: target.sessionId,
      kind: attempt.kind,
      operationId: attempt.operationId,
    }, {
      directory: target.directory,
      runtimeKey: target.runtimeKey,
    });
    return normalizeReceiptStatus(result);
  } catch {
    return 'unknown';
  }
};

/**
 * An unconfirmed transport error means the daemon may still have received the
 * send: retain the persisted attempt and hold — never auto-retry, never
 * cross-kind resend.
 */
export const isQueuedSendUnconfirmedError = (error: unknown): boolean => (
  error instanceof PiSendUnconfirmedError
);
