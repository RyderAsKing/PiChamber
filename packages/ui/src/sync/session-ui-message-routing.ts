import { getPiSessionStore } from '@/apps/pi-session-store';
import { isPiThinkingLevel } from '@/lib/pi/thinking';
import { sanitizeFilename } from '@/lib/pi/attachments';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  deriveStableMessageId,
  getSendIntent,
  isEvictedSendIntent,
  rememberSendIntent,
  setSendIntentAttachments,
} from '@/lib/pi/send-intent';
import { classifySendFailure } from '@/lib/pi/send-failure-classification';
import type { AttachedFile } from './session-ui-types';

/**
 * Route one send intent to its session.
 *
 * The send's model/thinking configuration is captured with the intent and
 * carried inline in the prompt payload (finding #4): the daemon applies it
 * atomically with acceptance inside its per-session config+acceptance lock.
 * There are deliberately no separate setModel/setThinking calls here — a
 * standalone config write could interleave with another connection's send,
 * a duplicate/retry would apply config twice, and a config failure would not
 * reliably prevent the Pi call.
 *
 * The verified stream epoch is captured before any upload so a restart
 * between upload and dispatch cannot silently re-stamp the same operation id
 * with a fresh epoch. Exact retries (transport, queue backoff, manual
 * confirmation of the same operation id) reuse every id verbatim — no
 * re-upload, no fresh message id, no fresh epoch — so the daemon fingerprint
 * never mismatches. `OPERATION_PAYLOAD_MISMATCH`, `OPERATION_EXPIRED`, and
 * `STALE_STREAM_EPOCH` surface as actionable failures that require an
 * explicit new intent; they never poison an endless retry loop.
 */
export async function routeMessage(params: {
  runtimeKey?: string;
  sessionId: string;
  directory?: string | null;
  content: string;
  providerID: string;
  modelID: string;
  agent?: string;
  agentMentionName?: string;
  variant?: string;
  inputMode?: 'normal' | 'shell';
  files?: Array<{
    type: 'file';
    mime: string;
    url: string;
    filename: string;
    uploadState?: AttachedFile['uploadState'];
  }>;
  additionalParts?: Array<{
    text: string;
    synthetic?: boolean;
    files?: Array<{
      type: 'file';
      mime: string;
      url: string;
      filename: string;
      uploadState?: AttachedFile['uploadState'];
    }>;
  }>;
  delivery?: 'steer' | 'followUp' | 'prompt';
  knownEmptyTranscript?: boolean;
  /**
   * Stable id for this send intent, reused across transport retries and
   * manual confirmations. Callers that own the intent (for example the
   * message queue, whose retry backoff re-dispatches the same queued entry)
   * pass it explicitly; every call is otherwise one intent. Never auto-mint
   * a fresh id for an uncertain send: an explicit new intent action is
   * required (with a warning) so a possibly-executed send cannot duplicate.
   */
  operationId?: string;
}): Promise<void> {
  const delivery =
    params.delivery === 'steer' || params.delivery === 'followUp'
      ? params.delivery
      : 'prompt';
  const sessionStore = getPiSessionStore();
  const operationId = params.operationId ?? `send_${crypto.randomUUID()}`;
  const thinking = isPiThinkingLevel(params.variant) ? params.variant : undefined;
  const model = params.providerID && params.modelID
    ? { providerId: params.providerID, modelId: params.modelID }
    : undefined;
  const intentRuntimeKey = (() => {
    if (typeof params.runtimeKey === 'string' && params.runtimeKey.length > 0) return params.runtimeKey;
    try {
      const live = getRuntimeKey();
      return typeof live === 'string' && live.length > 0 ? live : undefined;
    } catch { return undefined; }
  })();
  const payloadMismatchError = (message: string) =>
    Object.assign(new Error(message), { code: 'OPERATION_PAYLOAD_MISMATCH' });
  const hashDataUrlForFingerprint = (url: string): string => {
    let h1 = 5381;
    let h2 = 52711;
    for (let index = 0; index < url.length; index += 1) {
      h1 = (h1 * 33) ^ url.charCodeAt(index);
      h2 = (h2 * 33) ^ url.charCodeAt(index);
    }
    return `${url.length}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
  };
  const fingerprintOutgoingFile = (file: { mime: string; filename: string; url: string; uploadState?: AttachedFile['uploadState'] }): string => {
    const state = file.uploadState;
    if (state?.status === 'ready') return `ready:${state.attachmentId}`;
    if (typeof file.url === 'string' && file.url.startsWith('data:')) {
      return `data:${file.mime}|${file.filename}|${hashDataUrlForFingerprint(file.url)}`;
    }
    return `invalid:${state?.status ?? 'unknown'}:${file.mime}|${file.filename}`;
  };
  // An evicted operation id must never be recaptured with a fresh epoch or
  // fresh uploads: the original may already have executed, so the caller
  // needs a new operation id for a new send.
  if (!getSendIntent(operationId) && isEvictedSendIntent(operationId)) {
    throw new Error(
      'This send was evicted before confirmation. Check history, then send again as a new message (a new operation id is required).',
    );
  }
  // Stable full intent: retries of the same `operationId` reuse every id —
  // message, captured epoch, resolved upload ids, and owning runtime/session —
  // so the daemon fingerprint never mismatches. A cached intent with a
  // different text/config/attachments/runtime is a caller bug: it must use a
  // new operation id. Incoming attachments are compared without uploading:
  // any preparing/failed/expired/data payload that differs from the cached
  // resolved ids rejects instead of silently reusing old files or
  // re-uploading under the dispatched id.
  const cached = getSendIntent(operationId);
  if (cached) {
    if (cached.text !== params.content
      || (cached.model?.providerId ?? null) !== (model?.providerId ?? null)
      || (cached.model?.modelId ?? null) !== (model?.modelId ?? null)
      || (cached.thinking ?? null) !== (thinking ?? null)
      || cached.kind !== delivery
      || cached.sessionId !== params.sessionId) {
      throw payloadMismatchError('This operation id was already used with a different payload. Use a new operation id.');
    }
    if (cached.runtimeKey && intentRuntimeKey && cached.runtimeKey !== intentRuntimeKey) {
      throw payloadMismatchError('This operation id belongs to a different runtime. Use a new operation id.');
    }
    const incomingForFingerprint = [
      ...(params.files ?? []),
      ...(params.additionalParts ?? []).flatMap((part) => part.files ?? []),
    ].filter(
      (file) => file.uploadState !== undefined || file.url.startsWith('data:')
    );
    if (incomingForFingerprint.length !== cached.attachmentIds.length) {
      throw payloadMismatchError('This operation id was already used with different attachments. Use a new operation id.');
    }
    for (let index = 0; index < incomingForFingerprint.length; index += 1) {
      const file = incomingForFingerprint[index]!;
      const state = file.uploadState;
      if (state?.status === 'ready' && state.expiresAt > Date.now() && state.attachmentId === cached.attachmentIds[index]) {
        continue;
      }
      const cachedFingerprint = cached.attachmentFingerprints?.[index];
      if (cachedFingerprint && fingerprintOutgoingFile(file) === cachedFingerprint) {
        continue;
      }
      throw payloadMismatchError('This operation id was already used with different attachments. Use a new operation id.');
    }
    // Reuse the stable intent verbatim: no re-upload, no fresh message id,
    // no fresh epoch. The daemon deduplicates on the stable fingerprint.
    const promptAttachments = cached.attachmentIds.length > 0
      ? cached.attachmentIds.map((id) => ({ id }))
      : undefined;
    await sessionStore.prompt(
      params.sessionId,
      cached.text,
      cached.kind,
      promptAttachments,
      {
        ...(params.knownEmptyTranscript ? { knownEmptyTranscript: true as const } : {}),
        operationId: cached.operationId,
        messageId: cached.messageId,
        ...(cached.streamEpoch ? { streamEpoch: cached.streamEpoch } : {}),
        ...(cached.model ? { model: cached.model } : {}),
        ...(cached.thinking ? { thinking: cached.thinking as never } : {}),
      },
    );
    return;
  }
  const outgoingFiles = [
    ...(params.files ?? []),
    ...(params.additionalParts ?? []).flatMap((part) => part.files ?? []),
  ].filter(
    (file) => file.uploadState !== undefined || file.url.startsWith('data:')
  );
  const refreshedIds: string[] = [];
  // Capture the verified epoch before any upload. The store owns the epoch;
  // a retry must not re-stamp a fresh epoch after a restart (the daemon would
  // reject it as STALE_STREAM_EPOCH and the outcome would stay unknown —
  // never auto-replayed with the same id).
  const stampedEpoch = (() => {
    try {
      const epoch = sessionStore.getStreamEpoch?.();
      return typeof epoch === 'string' && epoch.length > 0 ? epoch : undefined;
    } catch { return undefined; }
  })();
  try {
    const attachments = await Promise.all(
      outgoingFiles.map(async (file) => {
        const state = file.uploadState;
        if (state?.status === 'preparing' || state?.status === 'uploading') {
          throw new Error('Attachments are still uploading.');
        }
        if (state?.status === 'failed') {
          throw new Error('Retry or remove failed attachments.');
        }
        if (state?.status === 'ready' && state.expiresAt > Date.now()) {
          return { id: state.attachmentId };
        }
        if (typeof file.url === 'string' && file.url.startsWith('data:')) {
          const response = await fetch(file.url);
          const blob = await response.blob();
          const attachment = await sessionStore.uploadFile(blob, {
            filename: sanitizeFilename(file.filename),
            mime: file.mime,
          });
          refreshedIds.push(attachment.id);
          return { id: attachment.id };
        }
        throw new Error(
          'Attachment data is unavailable. Remove the attachment and add it again.'
        );
      })
    );
    const promptAttachments = attachments.length > 0 ? attachments : undefined;
    const stableMessageId = deriveStableMessageId(operationId);
    // Remember the full intent before dispatch so any retry (transport,
    // queue backoff, manual confirmation) reuses every id verbatim, scoped
    // to the owning runtime/session. Original fingerprints let a same-payload
    // data retry reuse without re-upload while a changed payload rejects.
    rememberSendIntent({
      operationId,
      messageId: stableMessageId,
      sessionId: params.sessionId,
      kind: delivery,
      text: params.content,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      attachmentIds: attachments.map((a) => a.id),
      attachmentFingerprints: outgoingFiles.map((file) => fingerprintOutgoingFile(file)),
      ...(stampedEpoch ? { streamEpoch: stampedEpoch } : {}),
      ...(intentRuntimeKey ? { runtimeKey: intentRuntimeKey } : {}),
      createdAt: Date.now(),
    });
    const promptOptions = {
      ...(params.knownEmptyTranscript ? { knownEmptyTranscript: true as const } : {}),
      operationId,
      messageId: stableMessageId,
      ...(stampedEpoch ? { streamEpoch: stampedEpoch } : {}),
      // Send config captured with the intent (finding #4): the daemon applies
      // model+thinking atomically inside its config+acceptance lock, ordered
      // model-then-thinking so the model's thinking reset cannot clobber the
      // requested level.
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    };
    try {
      await sessionStore.prompt(
        params.sessionId,
        params.content,
        delivery,
        promptAttachments,
        promptOptions,
      );
    } catch (error) {
      // A definite rejection before execution frees the intent for a new
      // payload, but an uncertain outcome must keep the stable ids so a
      // retry deduplicates. Only drop freshly refreshed uploads on a
      // definite failure; uncertain paths keep them for the retry (the
      // daemon's retired attachment map still resolves a deduplicated
      // replay). The intent cache stays: same-id retries reuse it, and a
      // new payload with the same id is rejected above. Expired/stale/
      // mismatch require an explicit new intent and never auto-retry.
      const code = (error as { code?: unknown })?.code;
      if (code === 'OPERATION_EXPIRED' || code === 'STALE_STREAM_EPOCH' || code === 'OPERATION_PAYLOAD_MISMATCH') {
        setSendIntentAttachments(operationId, attachments.map((a) => a.id));
      }
      throw error;
    }
    // The daemon consumed the uploads; resolved ids stay cached for
    // deduplicated replays (the server retired map resolves them).
    setSendIntentAttachments(operationId, attachments.map((a) => a.id));
  } catch (error) {
    // Stable-intent cleanup: refreshed uploads are only deleted when the
    // same operation id will never be retried (it requires a new id).
    // Uncertain, aborted, and busy outcomes keep the ids so a same-id retry
    // reuses them verbatim instead of re-uploading to new ids (mismatch).
    const kind = (() => {
      try { return classifySendFailure(error); } catch { return 'rejected' as const; }
    })();
    const code = (error as { code?: unknown })?.code as string | undefined;
    const requiresNewId = code === 'OPERATION_EXPIRED'
      || code === 'STALE_STREAM_EPOCH'
      || code === 'OPERATION_PAYLOAD_MISMATCH'
      || (kind === 'rejected' && code !== 'SESSION_BUSY');
    if (requiresNewId) {
      await Promise.all(
        refreshedIds.map((id) =>
          sessionStore.deleteUpload(id).catch(() => undefined)
        )
      );
    }
    throw error;
  }
}
