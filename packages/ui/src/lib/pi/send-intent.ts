/**
 * Stable send-intent cache (findings #3/#4).
 *
 * One send intent is a stable full payload: `operationId`, `messageId`,
 * `text`, captured `model`/`thinking`, resolved upload ids, delivery kind,
 * session, and the captured `streamEpoch` it was stamped with. Transport
 * retries, queue backoff, and manual confirmations of the same intent must
 * reuse every id — generating a fresh `messageId` or re-uploading to new
 * server ids changes the fingerprint and the daemon rejects as
 * `OPERATION_PAYLOAD_MISMATCH`.
 *
 * The cache is in-memory per runtime (bounded, FIFO). `messageId` is derived
 * deterministically from `operationId`; `streamEpoch` and resolved upload ids
 * are cached when first resolved and held through retries. A stale epoch
 * (captured != current) is never replayed on the fresh daemon with the same
 * id — the caller must use a new operation id. Evicted ids leave a bounded
 * tombstone: reusing an evicted operation id with a fresh epoch or fresh
 * uploads would look like a new intent to the daemon but may duplicate an
 * already-executed send, so the caller must use a new operation id.
 */

export type SendIntentKind = 'prompt' | 'steer' | 'followUp';

export interface SendIntent {
  operationId: string;
  messageId: string;
  sessionId: string;
  kind: SendIntentKind;
  text: string;
  model?: { providerId: string; modelId: string };
  thinking?: string;
  attachmentIds: string[];
  streamEpoch?: string;
  /** Owning runtime for cache scope. Same op id on another runtime must not reuse files. */
  runtimeKey?: string;
  /**
   * Original attachment fingerprints at capture (`ready:<id>` or
   * `data:<mime>|<filename>|<len>:<hash>`). Lets a same-payload data retry
   * reuse the resolved ids without re-upload while a materially different
   * payload rejects instead of silently reusing old files.
   */
  attachmentFingerprints?: string[];
  createdAt: number;
}

const MAX_INTENTS = 256;
const MAX_EVICTED_TOMBSTONES = 1024;

const intentsByOperationId = new Map<string, SendIntent>();
const evictedOperationIds = new Map<string, number>();

const sanitizeForMessageId = (operationId: string): string => {
  const safe = operationId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
  return `msg_${safe || 'send'}`;
};

export const deriveStableMessageId = (operationId: string): string =>
  sanitizeForMessageId(operationId);

export const getSendIntent = (operationId: string): SendIntent | undefined =>
  intentsByOperationId.get(operationId);

/** True when the id was evicted from the bounded cache. Same-id reuse with a
 *  fresh epoch or fresh uploads must not silently become a new intent: the
 *  original may already have executed, so the caller needs a new operation id. */
export const isEvictedSendIntent = (operationId: string): boolean =>
  evictedOperationIds.has(operationId);

const rememberEvicted = (operationId: string): void => {
  evictedOperationIds.delete(operationId);
  evictedOperationIds.set(operationId, Date.now());
  while (evictedOperationIds.size > MAX_EVICTED_TOMBSTONES) {
    const oldest = evictedOperationIds.keys().next();
    if (oldest.done) break;
    evictedOperationIds.delete(oldest.value);
  }
};

export const rememberSendIntent = (intent: SendIntent): SendIntent => {
  const existing = intentsByOperationId.get(intent.operationId);
  if (existing) {
    return existing;
  }
  if (evictedOperationIds.has(intent.operationId)) {
    throw new Error(
      'This operation id was evicted from the send-intent cache. Use a new operation id for a new send.',
    );
  }
  intentsByOperationId.set(intent.operationId, intent);
  while (intentsByOperationId.size > MAX_INTENTS) {
    const oldest = intentsByOperationId.keys().next();
    if (oldest.done) break;
    const evicted = oldest.value;
    intentsByOperationId.delete(evicted);
    rememberEvicted(evicted);
  }
  return intent;
};

/** Update cached upload ids after the first successful resolve. Held for retries. */
export const setSendIntentAttachments = (operationId: string, attachmentIds: string[]): void => {
  const existing = intentsByOperationId.get(operationId);
  if (existing) {
    existing.attachmentIds = [...attachmentIds];
  }
};

export const clearSendIntentsForTests = (): void => {
  intentsByOperationId.clear();
  evictedOperationIds.clear();
};
