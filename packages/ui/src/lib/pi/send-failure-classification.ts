/**
 * Send-failure classification (finding #3).
 *
 * A prompt/steer/follow-up send can fail in very different ways:
 *
 * - `rejected` — the server responded with an error status. The attempt was
 *   authoritatively declined on the current daemon (its operation id was
 *   never accepted for this attempt), so the optimistic send can be rolled
 *   back as a real failure. `STALE_STREAM_EPOCH` and `OPERATION_EXPIRED`
 *   are rejections of this attempt that still require a NEW operation id:
 *   the old daemon may have executed the original intent, so the same id
 *   must never automatically re-execute. `OPERATION_PAYLOAD_MISMATCH` is a
 *   caller bug (same id, different payload) and must not be retried with
 *   the same id.
 * - `uncertain` — the request was dispatched but its outcome is unknown:
 *   a tagged ambiguous transport failure, a request timeout, or a network
   * error. Treating this as a definite failure is a false failure: the send
 *   may already be executing, and blind retry could double-execute it.
 *   Callers keep the send pending and confirm via the exact authenticated
 *   `sessions.sendReceipt` status (never generic lifecycle); a retry must
 *   reuse the same stable full intent (operation/message id, content,
 *   captured config, upload ids, captured epoch) so the daemon's execution
 *   boundary deduplicates.
 * - `aborted` — the request was cancelled locally (caller abort, server
 *   `SESSION_ABORTED` during acceptance, or a runtime switch guard).
 *   Distinct from both a server rejection and an uncertain outcome; the
 *   caller treats it as a local cancellation. An abort during acceptance
 *   freed its operation id (nothing executed), so a retry with the same id
 *   is safe, but an old abort must never cancel newer work (generation-
 *   scoped abort contract).
 */
import { isAmbiguousTransportFailure } from '@/lib/relay/transport-error';

type SendFailureKind = 'rejected' | 'uncertain' | 'aborted';

export const classifySendFailure = (error: unknown): SendFailureKind => {
  if (isAmbiguousTransportFailure(error)) return 'uncertain';
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && ((error as { code?: unknown }).code === 'DAEMON_UNAVAILABLE'
      || (error as { code?: unknown }).code === 'SESSION_ABORTED')
  ) {
    // Runtime-switch and daemon-availability guards cancel the send locally;
    // a server abort during acceptance is also a local cancellation (nothing
    // executed, id freed), not a definite failure of a new intent.
    return 'aborted';
  }
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'DAEMON_TIMEOUT'
  ) {
    return 'uncertain';
  }
  if (error instanceof Error && (error.name === 'TypeError' || error.name === 'NetworkError')) {
    // fetch() network failure: the request may or may not have been dispatched.
    return 'uncertain';
  }
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return 'rejected';
  }
  // Anything unclassified could have reached the server; never claim a
  // definite failure.
  return 'uncertain';
};
