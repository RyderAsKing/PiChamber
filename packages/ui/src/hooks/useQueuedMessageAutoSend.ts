import React from 'react';
import type { SessionStatus } from '@/lib/chat/types';
import { getMessageQueueKey, parseMessageQueueKey, queuedSendOperationId, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getDirectoryState } from '@/sync/sync-refs';
import { useDirectorySync } from '@/sync/sync-context';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { deriveStableMessageId, getSendIntent, rememberSendIntent } from '@/lib/pi/send-intent';
import { sanitizeFilename } from '@/lib/pi/attachments';
import type { AttachedFile } from '@/stores/types/sessionTypes';

type SessionStatusType = 'idle' | 'busy' | 'retry';

const RECENT_ABORT_WINDOW_MS = 2000;

const AUTO_SEND_RETRY_BASE_DELAY_MS = 2000;
const AUTO_SEND_RETRY_MAX_DELAY_MS = 60000;

/**
 * Stable operation id for one queued send intent (finding #3). Canonical
 * owner is `@/stores/messageQueueStore`; re-exported here so existing
 * callers keep working. See the store for the full contract.
 */
export { queuedSendOperationId } from '@/stores/messageQueueStore';

const REQUIRES_NEW_ID_CODES = new Set([
  'OPERATION_EXPIRED',
  'STALE_STREAM_EPOCH',
  'OPERATION_PAYLOAD_MISMATCH',
]);

const isRequiresNewIdError = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && REQUIRES_NEW_ID_CODES.has(code);
};

/**
 * Whether a persisted queue entry may auto-dispatch on this runtime/epoch.
 * Returns a reason when blocked so callers preserve (never delete) the entry
 * and never schedule an automatic retry for it.
 *
 * - Missing authority (legacy entry): the original may already have executed
 *   before a restart, so automatic reexecution is prohibited. An explicit new
 *   intent is required.
 * - Runtime mismatch: entries are runtime-scoped; a switch never replays them.
 * - Missing epoch: a missing captured epoch or a missing verified epoch
 *   blocks dispatch. Reusing the same operation id with a fresh epoch would
 *   look like a new intent and may duplicate an executed send.
 * - Stale epoch: the captured daemon lifetime differs from the verified one.
 *   Reusing the same operation id with a fresh epoch would look like a new
 *   intent and may duplicate an executed send.
 */
export const getQueuedAutoSendBlockedReason = (
  queued: QueuedMessage,
  target: MessageQueueTarget,
  currentRuntimeKey: string,
  currentEpoch: string | null | undefined,
): string | null => {
  const authority = queued.sendAuthority;
  if (!authority) return 'missing-authority';
  if (authority.runtimeKey !== currentRuntimeKey || authority.runtimeKey !== target.runtimeKey) {
    return 'runtime-mismatch';
  }
  if (authority.operationId !== queuedSendOperationId(queued.id)) return 'operation-mismatch';
  if (!authority.streamEpoch || !currentEpoch) {
    return 'missing-epoch';
  }
  if (authority.streamEpoch !== currentEpoch) {
    return 'stale-epoch';
  }
  return null;
};

export type QueuedAutoSendFailure = {
  messageId: string;
  failures: number;
  nextAttemptAt: number;
};

export const getQueuedAutoSendRetryDelayMs = (failures: number): number =>
  Math.min(AUTO_SEND_RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), AUTO_SEND_RETRY_MAX_DELAY_MS);

export const isQueuedAutoSendBackedOff = (
  failure: QueuedAutoSendFailure | undefined,
  messageId: string,
  now: number,
): boolean => failure !== undefined && failure.messageId === messageId && now < failure.nextAttemptAt;

export const createQueuedAutoSendRetryScheduler = (
  onWake: () => void,
  now: () => number = Date.now,
  scheduleTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancelTimeout: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledAt: number | null = null;

  return {
    schedule(retryAt: number) {
      if (scheduledAt !== null && scheduledAt <= retryAt) return;
      if (timer !== null) cancelTimeout(timer);
      scheduledAt = retryAt;
      timer = scheduleTimeout(() => {
        timer = null;
        scheduledAt = null;
        onWake();
      }, Math.max(0, retryAt - now()));
    },
    dispose() {
      if (timer !== null) cancelTimeout(timer);
      timer = null;
      scheduledAt = null;
    },
  };
};

/**
 * When the abort window is still open, returns the time it expires so the
 * caller can wake the queue then. Returns `null` once sending is allowed
 * again — a queued item must not wait for an unrelated state change to be
 * retried after the window closes.
 */
const getAbortHoldUntil = (sessionId: string): number | null => {
  const abortRecord = useSessionUIStore.getState().sessionAbortFlags.get(sessionId);
  if (!abortRecord) {
    return null;
  }
  const holdUntil = abortRecord.timestamp + RECENT_ABORT_WINDOW_MS;
  return Date.now() < holdUntil ? holdUntil : null;
};

export const buildQueuedAutoSendPayload = (queue: QueuedMessage[]) => {
  const queued = queue[0];
  if (!queued) {
    return null;
  }

  const agents = useConfigStore.getState().getVisibleAgents();
  const { sanitizedText, mention } = parseAgentMentions(queued.content, agents);

  return {
    queuedMessageId: queued.id,
    primaryText: sanitizedText,
    primaryAttachments: queued.attachments ?? [],
    agentMentionName: mention?.name,
    sendConfig: queued.sendConfig,
  };
};

type QueuedAutoSendPayload = NonNullable<ReturnType<typeof buildQueuedAutoSendPayload>>;
type ResolvedQueuedSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

/**
 * Rehydrate the durable send-intent cache from a persisted queue entry after
 * a reload. All-or-nothing: every attachment must be a still-valid ready
 * upload whose id matches the persisted exact manifest (when present), and
 * the text/config/session/runtime must match verbatim — otherwise nothing is
 * cached and the caller must block (dispatched) or take the fresh upload
 * path (explicit fresh only). In particular data/preparing/failed/expired or
 * unknown manifests never produce a cached `[]` that would let the cached
 * route silently send text-only. Expired ready uploads are not reused: the
 * send layer blocks with an actionable error instead of re-uploading to new
 * ids under the original uncertain id. Returns true when an intent is cached.
 */
export const rehydrateSendIntentFromQueueEntry = (
  target: MessageQueueTarget,
  queued: QueuedMessage,
  primaryText: string,
  resolved: ResolvedQueuedSendConfig,
): boolean => {
  const authority = queued.sendAuthority;
  if (!authority) return false;
  const operationId = queuedSendOperationId(queued.id);
  if (authority.operationId !== operationId) return false;
  if (authority.runtimeKey !== target.runtimeKey) return false;
  if (authority.sessionId && authority.sessionId !== target.sessionId) return false;
  if (getSendIntent(operationId)) return true;
  if (authority.text !== undefined && authority.text !== primaryText) return false;
  if (authority.sendConfig) {
    if (authority.sendConfig.providerID !== resolved.providerID) return false;
    if (authority.sendConfig.modelID !== resolved.modelID) return false;
    if ((authority.sendConfig.agent ?? undefined) !== (resolved.agent ?? undefined)) return false;
    if ((authority.sendConfig.variant ?? undefined) !== (resolved.variant ?? undefined)) return false;
  }
  const current = queued.attachments ?? [];
  const derivedIds: string[] = [];
  for (const attachment of current) {
    const state = attachment.uploadState;
    if (state?.status === 'ready' && state.expiresAt > Date.now()) {
      derivedIds.push(state.attachmentId);
    } else {
      return false;
    }
  }
  if (authority.attachmentIds !== undefined) {
    if (authority.attachmentIds.length !== derivedIds.length) return false;
    for (let index = 0; index < derivedIds.length; index += 1) {
      if (authority.attachmentIds[index] !== derivedIds[index]) return false;
    }
  }
  try {
    const finalIds = authority.attachmentIds ? [...authority.attachmentIds] : derivedIds;
    rememberSendIntent({
      operationId,
      messageId: authority.messageId || deriveStableMessageId(operationId),
      sessionId: target.sessionId,
      kind: 'prompt',
      text: primaryText,
      ...(resolved.providerID && resolved.modelID
        ? { model: { providerId: resolved.providerID, modelId: resolved.modelID } }
        : {}),
      ...(resolved.variant ? { thinking: resolved.variant } : {}),
      attachmentIds: finalIds,
      attachmentFingerprints: finalIds.map((id) => `ready:${id}`),
      ...(authority.streamEpoch ? { streamEpoch: authority.streamEpoch } : {}),
      runtimeKey: target.runtimeKey,
      createdAt: authority.capturedAt ?? Date.now(),
    });
    return true;
  } catch {
    // Evicted-tombstone ids must never be recaptured: the caller needs a new
    // operation id for a new send.
    return false;
  }
};

const queuedDispatchBlockedError = (reason: string | null, message: string): Error => {
  const code = reason === 'missing-epoch' || reason === 'stale-epoch'
    ? 'STALE_STREAM_EPOCH'
    : reason === 'expired-attachment'
      ? 'OPERATION_EXPIRED'
      : 'OPERATION_PAYLOAD_MISMATCH';
  return Object.assign(new Error(message), { code });
};

const hasExpiredReadyAttachment = (attachments: readonly AttachedFile[] | undefined): boolean =>
  (attachments ?? []).some((attachment) => {
    const state = attachment.uploadState;
    return state?.status === 'ready' && state.expiresAt <= Date.now();
  });

const isExplicitFreshAuthority = (queued: QueuedMessage): boolean =>
  queued.sendAuthority?.dispatched === false;

/**
 * Dispatch one queued payload through the real `sendMessage → routeMessage →
 * prompt` chain with explicit fresh-vs-dispatched authority.
 *
 * - The epoch/runtime/operation gate is enforced here as well as in the
 *   auto-send effect, so a blocked entry never reaches upload/prompt (zero
 *   uploads, zero prompts) even when called directly.
 * - Dispatched (previously sent, outcome uncertain) entries never fall
 *   through to a fresh upload under the same operation id: a failed
 *   rehydration throws a requires-new-id error instead of best-effort
 *   sending text-only or re-uploading.
 * - Explicit fresh (`dispatched: false`) entries whose attachments are all
 *   data-uploadable are uploaded once here, persisted (ready ids + exact
 *   text/config/manifest + `dispatched: true`) before dispatch, then sent
 *   with the resolved ready ids so the route reuses them verbatim. Fresh
 *   preparing/failed/expired-without-bytes entries proceed to the normal
 *   route, which rejects before dispatch (zero prompts, no text-only send).
 */
export const sendQueuedAutoSendPayload = async (
  target: MessageQueueTarget,
  payload: QueuedAutoSendPayload,
  resolved: ResolvedQueuedSendConfig,
) => {
  const operationId = queuedSendOperationId(payload.queuedMessageId);
  const queueState = useMessageQueueStore.getState();
  const queuedEntry = queueState.getQueueForTarget(target).find((entry) => entry.id === payload.queuedMessageId);
  let effectiveAttachments: AttachedFile[] = payload.primaryAttachments as AttachedFile[];
  if (queuedEntry) {
    let currentRuntimeKey = target.runtimeKey;
    try {
      const live = getRuntimeKey();
      if (typeof live === 'string' && live.length > 0) currentRuntimeKey = live;
    } catch { /* keep target runtime for the gate check */ }
    let currentEpoch: string | null = null;
    try {
      currentEpoch = getPiSessionStore().getStreamEpoch?.() ?? null;
    } catch { currentEpoch = null; }
    const blockedReason = getQueuedAutoSendBlockedReason(queuedEntry, target, currentRuntimeKey, currentEpoch);
    if (blockedReason !== null) {
      throw queuedDispatchBlockedError(blockedReason, 'Queued send is blocked: check history, then send again as a new message.');
    }
    const fresh = isExplicitFreshAuthority(queuedEntry);
    let rehydrated = false;
    try {
      rehydrated = rehydrateSendIntentFromQueueEntry(target, queuedEntry, payload.primaryText, resolved);
    } catch {
      rehydrated = false;
    }
    if (rehydrated) {
      if (fresh) {
        try {
          const derived = (queuedEntry.attachments ?? []).flatMap((attachment) => {
            const state = attachment.uploadState;
            return state?.status === 'ready' ? [state.attachmentId] : [];
          });
          queueState.setQueuedSendAuthority(target, queuedEntry.id, {
            ...queuedEntry.sendAuthority!,
            sessionId: target.sessionId,
            text: payload.primaryText,
            sendConfig: {
              providerID: resolved.providerID,
              modelID: resolved.modelID,
              ...(resolved.agent ? { agent: resolved.agent } : {}),
              ...(resolved.variant ? { variant: resolved.variant } : {}),
            },
            attachmentIds: [...derived],
            dispatched: true,
          });
        } catch { /* flag flip is best-effort; the cached intent still guards the send */ }
      }
    } else if (!fresh) {
      const expired = hasExpiredReadyAttachment(queuedEntry.attachments);
      throw queuedDispatchBlockedError(
        expired ? 'expired-attachment' : 'attachment-mismatch',
        expired
          ? 'Queued attachments expired. Re-add the files, then send again as a new message.'
          : 'Queued attachments changed or are unavailable. Re-add the files, then send again as a new message.',
      );
    } else {
      const pendingOrFailed = (queuedEntry.attachments ?? []).some((attachment) => {
        const status = attachment.uploadState?.status;
        return status === 'preparing' || status === 'uploading' || status === 'failed';
      });
      const allUploadableOrReady = (queuedEntry.attachments ?? []).every((attachment) => {
        const state = attachment.uploadState;
        if (state?.status === 'ready' && state.expiresAt > Date.now()) return true;
        return typeof attachment.dataUrl === 'string' && attachment.dataUrl.startsWith('data:');
      });
      if (!pendingOrFailed && allUploadableOrReady && (queuedEntry.attachments ?? []).some((attachment) => attachment.uploadState?.status !== 'ready')) {
        const sessionStore = getPiSessionStore();
        const resolvedReady: AttachedFile[] = [];
        const resolvedIds: string[] = [];
        for (const attachment of (queuedEntry.attachments ?? [])) {
          const state = attachment.uploadState;
          if (state?.status === 'ready' && state.expiresAt > Date.now()) {
            resolvedReady.push(attachment);
            resolvedIds.push(state.attachmentId);
            continue;
          }
          const response = await fetch(attachment.dataUrl);
          const blob = await response.blob();
          const uploaded = await (sessionStore as unknown as { uploadFile: (blob: Blob, input: { filename: string; mime: string }) => Promise<{ id: string; expiresAt?: number }> }).uploadFile(blob, {
            filename: sanitizeFilename(attachment.filename),
            mime: attachment.mimeType,
          });
          const expiresAt = typeof uploaded.expiresAt === 'number' ? uploaded.expiresAt : Date.now() + 60 * 60 * 1000;
          resolvedIds.push(uploaded.id);
          resolvedReady.push({
            ...attachment,
            dataUrl: '',
            previewUrl: undefined,
            file: undefined as unknown as File,
            uploadState: { status: 'ready', attachmentId: uploaded.id, expiresAt },
          });
        }
        const key = getMessageQueueKey(target);
        try {
          useMessageQueueStore.setState((state) => {
            const queue = state.queuedMessages[key] ?? [];
            const index = queue.findIndex((entry) => entry.id === queuedEntry.id);
            if (index < 0) return state;
            const next = queue.slice();
            next[index] = {
              ...next[index]!,
              attachments: resolvedReady,
              sendAuthority: {
                ...next[index]!.sendAuthority!,
                sessionId: target.sessionId,
                text: payload.primaryText,
                sendConfig: {
                  providerID: resolved.providerID,
                  modelID: resolved.modelID,
                  ...(resolved.agent ? { agent: resolved.agent } : {}),
                  ...(resolved.variant ? { variant: resolved.variant } : {}),
                },
                attachmentIds: [...resolvedIds],
                dispatched: true,
              },
            };
            return { queuedMessages: { ...state.queuedMessages, [key]: next } };
          });
        } catch { /* persisted manifest is required; a failed write must not dispatch */
          throw queuedDispatchBlockedError('attachment-mismatch', 'Queued attachments could not be saved before send.');
        }
        effectiveAttachments = resolvedReady;
        const refreshed = useMessageQueueStore.getState().getQueueForTarget(target).find((entry) => entry.id === queuedEntry.id);
        if (refreshed && !rehydrateSendIntentFromQueueEntry(target, refreshed, payload.primaryText, resolved)) {
          throw queuedDispatchBlockedError('attachment-mismatch', 'Queued attachments changed before send.');
        }
      }
    }
  }
  return useSessionUIStore.getState().sendMessage(
    payload.primaryText,
    resolved.providerID,
    resolved.modelID,
    resolved.agent,
    effectiveAttachments,
    payload.agentMentionName,
    undefined,
    resolved.variant,
    'normal',
    { target, operationId },
  );
};

const resolveSessionSendConfig = (sessionId: string) => {
  const context = useContextStore.getState();
  const config = useConfigStore.getState();
  const selection = useSelectionStore.getState();

  const selectedAgent =
    context.getSessionAgentSelection(sessionId)
    ?? context.getCurrentAgent(sessionId)
    ?? config.currentAgentName
    ?? undefined;

  const sessionModel = context.getSessionModelSelection(sessionId);
  const agentModel = selectedAgent
    ? context.getAgentModelForSession(sessionId, selectedAgent)
    : null;

  const providerID =
    agentModel?.providerId
    ?? sessionModel?.providerId
    ?? config.currentProviderId
    ?? selection.lastUsedProvider?.providerID;
  const modelID =
    agentModel?.modelId
    ?? sessionModel?.modelId
    ?? config.currentModelId
    ?? selection.lastUsedProvider?.modelID;

  const variant =
    selectedAgent && providerID && modelID
      ? (selection.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID)
        ?? context.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID))
      : undefined;

  return {
    providerID,
    modelID,
    agent: selectedAgent,
    variant,
  };
};

export const shouldDispatchQueuedAutoSend = (
  previousStatusType: SessionStatusType | undefined,
  currentStatusType: SessionStatusType,
  hasQueuedItems: boolean = false,
): boolean => {
  if (hasQueuedItems && currentStatusType === 'idle') return true;
  return (previousStatusType === 'busy' || previousStatusType === 'retry')
    && currentStatusType === 'idle';
};

/**
 * Resolve the live status the queue gate should honor for a session.
 *
 * The server's `/session/status` map only lists busy/retry sessions — idle
 * sessions are absent — so a missing entry means "idle per the snapshot", not
 * "no information". A missed busy event therefore leaves no entry while a turn
 * is still streaming. The trailing in-flight assistant message is the live
 * evidence of that running turn: treat it as busy so the queue never dispatches
 * into it (mirrors `useSessionActivity`'s fallback). The entry becomes idle the
 * moment the message completes or an idle status event lands. This reads the
 * directory child store directly so both the effect-loop gate and the
 * dispatch-time re-check agree.
 */
export const resolveQueuedSessionStatusType = (
  sessionId: string,
  directory: string,
): SessionStatusType => {
  const state = getDirectoryState(directory);
  const statusType = state?.session_status?.[sessionId]?.type;
  if (statusType === 'busy' || statusType === 'retry') {
    return statusType;
  }
  const sessionMessages = state?.message?.[sessionId];
  const lastMessage = sessionMessages && sessionMessages.length > 0
    ? sessionMessages[sessionMessages.length - 1]
    : undefined;
  if (
    lastMessage?.role === 'assistant'
    && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number'
  ) {
    return 'busy';
  }
  return 'idle';
};

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const sessionStatusRecord = useDirectorySync<Record<string, SessionStatus>>((state) => state.session_status);
  // Message completion clears the in-flight fallback in
  // resolveQueuedSessionStatusType; subscribe so the queue drains the moment
  // the trailing assistant message completes even if status events were missed.
  const sessionMessages = useDirectorySync((state) => state.message);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const sendFailuresRef = React.useRef<Map<string, QueuedAutoSendFailure>>(new Map());
  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());
  const [retryTick, setRetryTick] = React.useState(0);
  const retryScheduler = React.useMemo(
    () => createQueuedAutoSendRetryScheduler(() => setRetryTick((value) => value + 1)),
    [],
  );

  React.useEffect(() => () => retryScheduler.dispose(), [retryScheduler]);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const dispatchSessionQueue = async (target: MessageQueueTarget, queueSnapshot: QueuedMessage[]) => {
      const { sessionId } = target;
      const targetKey = getMessageQueueKey(target);
      if (queueSnapshot.length === 0) {
        return;
      }
      if (inFlightSessionsRef.current.has(targetKey)) {
        return;
      }
      const abortHoldUntil = getAbortHoldUntil(sessionId);
      if (abortHoldUntil !== null) {
        retryScheduler.schedule(abortHoldUntil);
        return;
      }
      const currentStatus = resolveQueuedSessionStatusType(sessionId, target.directory);
      if (currentStatus !== 'idle') {
        return;
      }

      // Read the queue back at dispatch time and skip anything already being
      // delivered, rather than trusting the render-time snapshot.
      const sendable = useMessageQueueStore.getState().getSendableQueue(target);
      const payload = buildQueuedAutoSendPayload(sendable);
      if (!payload) {
        return;
      }
      const queuedEntry = sendable.find((m) => m.id === payload.queuedMessageId);
      if (!queuedEntry) return;

      // Authority gate: never auto-reexecute without the original captured
      // epoch/identity, across runtimes, or across a verified epoch change.
      // Blocked entries are preserved (drafts and failed entries survive) and
      // never scheduled for automatic retry; an explicit new intent is
      // required. A missing verified epoch (pre-first-health) waits.
      const currentRuntimeKey = getRuntimeKey();
      let currentEpoch: string | null = null;
      try {
        currentEpoch = getPiSessionStore().getStreamEpoch?.() ?? null;
      } catch { currentEpoch = null; }
      if (currentEpoch === null) {
        retryScheduler.schedule(Date.now() + AUTO_SEND_RETRY_BASE_DELAY_MS);
        return;
      }
      const blockedReason = getQueuedAutoSendBlockedReason(queuedEntry, target, currentRuntimeKey, currentEpoch);
      if (blockedReason !== null) {
        return;
      }

      const failure = sendFailuresRef.current.get(targetKey);
      if (failure && failure.messageId !== payload.queuedMessageId) {
        sendFailuresRef.current.delete(targetKey);
      } else if (failure && isQueuedAutoSendBackedOff(failure, payload.queuedMessageId, Date.now())) {
        retryScheduler.schedule(failure.nextAttemptAt);
        return;
      }

      // Use send config captured at queue time; fall back to current config
      const captured = payload.sendConfig;
      const resolved = captured?.providerID && captured?.modelID
        ? captured
        : resolveSessionSendConfig(sessionId);
      if (!resolved.providerID || !resolved.modelID) {
        // Legacy queues may predate captured send configuration. Config
        // hydration is asynchronous, so retry instead of stranding the item
        // until an unrelated status or directory update happens.
        retryScheduler.schedule(Date.now() + AUTO_SEND_RETRY_BASE_DELAY_MS);
        return;
      }

      inFlightSessionsRef.current.add(targetKey);
      // The ref only guards this hook. Publish the dispatch to the store so the
      // composer cannot merge the same item into a parallel send while this one
      // is still awaiting the server.
      useMessageQueueStore.getState().markSending(target, payload.queuedMessageId);

      try {
        await sendQueuedAutoSendPayload(target, payload, {
          providerID: resolved.providerID,
          modelID: resolved.modelID,
          agent: resolved.agent,
          variant: resolved.variant,
        });
        useMessageQueueStore.getState().removeFromQueue(target, payload.queuedMessageId);
        sendFailuresRef.current.delete(targetKey);
      } catch (error) {
        console.warn('[queue] queued auto-send failed:', error);
        // Expired/stale/mismatch require an explicit new intent and must never
        // poison an endless retry loop. Preserve the entry and stop: the
        // prompt layer already surfaced an actionable outcome-unknown.
        if (isRequiresNewIdError(error)) {
          sendFailuresRef.current.delete(targetKey);
          return;
        }
        // An outcome-unknown send acceptance (for example a receipt that came
        // back expired/unknown after an uncertain dispatch) must also stop
        // automatic retries with the same id. Preserve the entry for an
        // explicit new intent.
        try {
          const sendState = getPiSessionStore().getSendState?.(sessionId);
          if (sendState?.status === 'outcome-unknown') {
            sendFailuresRef.current.delete(targetKey);
            return;
          }
        } catch { /* keep the backoff path when the store is unavailable */ }
        const priorFailures = failure?.messageId === payload.queuedMessageId ? failure.failures : 0;
        const failures = priorFailures + 1;
        const nextAttemptAt = Date.now() + getQueuedAutoSendRetryDelayMs(failures);
        sendFailuresRef.current.set(targetKey, {
          messageId: payload.queuedMessageId,
          failures,
          nextAttemptAt,
        });
        retryScheduler.schedule(nextAttemptAt);
      } finally {
        inFlightSessionsRef.current.delete(targetKey);
        useMessageQueueStore.getState().clearSending(target, payload.queuedMessageId);
      }
    };

    const statusRecord = sessionStatusRecord ?? {};
    const nextStatusMap = new Map(previousStatusRef.current);
    for (const [sessionId, status] of Object.entries(statusRecord)) {
      if (status) {
        nextStatusMap.set(sessionId, status.type as SessionStatusType);
      }
    }

    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([key, queue]) => {
      const target = parseMessageQueueKey(key);
      if (!target || target.runtimeKey !== getRuntimeKey() || target.directory !== currentDirectory) return;
      const { sessionId } = target;
      const currentStatusType = resolveQueuedSessionStatusType(sessionId, target.directory);
      const previousStatusType = previousStatusRef.current.get(sessionId);


      if (queue.length > 0 && (
        shouldDispatchQueuedAutoSend(previousStatusType, currentStatusType, queue.length > 0)
      )) {
        void dispatchSessionQueue(target, queue);
      }

      nextStatusMap.set(sessionId, currentStatusType);
    });

    previousStatusRef.current = nextStatusMap;
  }, [enabled, queuedMessages, sessionStatusRecord, sessionMessages, currentDirectory, retryTick, retryScheduler]);
}
