import React from 'react';
import { getMessageQueueKey, parseMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { isQueuedSendUnconfirmedError } from '@/stores/queuedSendReceipt';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { usePiSessionSnapshot, usePiSessionStore } from '@/sync/pi-session-context';
import { TOPIC_CATALOG, TOPIC_CHROME, isInvalidSessionError, type PiSessionStoreState } from '@/apps/pi-session-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { normalizePath } from '@/lib/pathNormalization';
import { toast } from '@/components/ui';

const RECENT_ABORT_WINDOW_MS = 2000;

/** Hydration-demand backoff lives in the per-target failure map under this
 *  sentinel message id, reusing the bounded backoff and retry scheduler.
 *  Failed follow-up sends share the map but hold indefinitely (no schedule)
 *  instead of retrying an ambiguous delivery — recovery is explicit. */
const HYDRATE_DEMAND_FAILURE_ID = 'hydrate-demand';

const AUTO_SEND_RETRY_BASE_DELAY_MS = 2000;
const AUTO_SEND_RETRY_MAX_DELAY_MS = 60000;

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

  // No generic-agent registry exists (the Pi daemon exposes no agent list
  // endpoint), so queued content carries no agent mention to parse.
  return {
    queuedMessageId: queued.id,
    primaryText: queued.content,
    primaryAttachments: queued.attachments ?? [],
    agentMentionName: undefined,
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

export const sendQueuedAutoSendPayload = (
  target: MessageQueueTarget,
  payload: QueuedAutoSendPayload,
  resolved: ResolvedQueuedSendConfig,
) => {
  // Hands to the SDK only at the authoritative idle gate, but dispatches as
  // delivery:'followUp' so a turn that went busy between gate and arrival
  // follows up rather than failing SESSION_BUSY. The stable queue id travels
  // as operationId so a receipt check can reconcile an uncertain delivery —
  // never as an automatic retry.
  return useSessionUIStore.getState().sendMessage(
    payload.primaryText,
    resolved.providerID,
    resolved.modelID,
    resolved.agent,
    payload.primaryAttachments,
    payload.agentMentionName,
    undefined,
    resolved.variant,
    'normal',
    {
      target,
      delivery: 'followUp',
      operationId: payload.queuedMessageId,
    },
  );
};

export const resolveSessionSendConfig = (sessionId: string) => {
  const config = useConfigStore.getState();
  const selection = useSelectionStore.getState();

  // Canonical per-session preferences own agent/model/variant resolution.
  // Legacy `currentAgentContext` was folded into `sessionAgentSelections`
  // during the one-time context-store migration, so there is no second map.
  const selectedAgent =
    selection.getSessionAgentSelection(sessionId)
    ?? undefined;

  const sessionModel = selection.getSessionModelSelection(sessionId);
  const agentModel = selectedAgent
    ? selection.getAgentModelForSession(sessionId, selectedAgent)
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
      ? selection.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID)
      : undefined;

  return {
    providerID,
    modelID,
    agent: selectedAgent,
    variant,
  };
};

/**
 * Tri-state dispatch gate resolved against the connected runtime's live
 * `PiSessionStore`. `'ready'` grants dispatch only on live evidence of a
 * terminal (`idle`/`error`) lifecycle on an owning, hydrated, non-archived
 * row. `'busy'` holds on a live `busy`/`retry` mirror. `'unknown'` means no
 * dispatch decision is possible — disconnected runtime, missing/colliding/
 * archived/cold row — and holds: the persisted first-paint cache restores
 * every row as `idle` with `hydrated=false`, so cached `idle` is metadata,
 * never authority, and `unknown` never dispatches.
 */
type QueuedAutoSendReadiness = 'ready' | 'busy' | 'unknown';

export const resolveQueuedAutoSendReadiness = (
  state: PiSessionStoreState,
  target: MessageQueueTarget,
): QueuedAutoSendReadiness => {
  // A disconnected / errored / still-attaching runtime has no live
  // lifecycle at all — its catalog rows must not be read as idle.
  if (state.connection !== 'ready') {
    return 'unknown';
  }
  const record = state.catalog.byId.get(target.sessionId);
  // A missing authoritative target cannot invent idle.
  if (!record) {
    return 'unknown';
  }
  // Directory ownership must match the captured target (normalized): a
  // colliding session id from another directory must never receive the send.
  if (normalizePath(record.directory) !== normalizePath(target.directory)) {
    return 'unknown';
  }
  // Archived sessions never receive queued auto-sends.
  if (record.archived) {
    return 'unknown';
  }
  // A confirmed invalid session can never hydrate: the authoritative
  // getSession failed with INVALID_SESSION and that error is retained until
  // a later successful reload clears it. Hold dispatch ('unknown') so the
  // queued entry stays for user inspection/removal.
  if (isInvalidSessionError(state.sessionLoadErrorById.get(target.sessionId))) {
    return 'unknown';
  }
  if (record.lifecycle === 'busy' || record.lifecycle === 'retry') {
    return 'busy';
  }
  // `idle`/`error` are terminal, but only live evidence may grant dispatch.
  if (!record.hydrated) {
    return 'unknown';
  }
  return 'ready';
};

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const store = usePiSessionStore();

  // Wake the dispatch scanner on live lifecycle edges and connection
  // transitions only. The catalog topic emits at lifecycle/list/title
  // boundaries — token deltas mutate neither the catalog nor the
  // connection, so streaming never wakes this scanner — and the scanner
  // itself reads one catalog row per queued target, never a transcript.
  const catalog = usePiSessionSnapshot((state) => state.catalog, undefined, TOPIC_CATALOG);
  const connection = usePiSessionSnapshot((state) => state.connection, undefined, TOPIC_CHROME);

  // Per-target guard for async work (queued send or hydration demand).
  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const sendFailuresRef = React.useRef<Map<string, QueuedAutoSendFailure>>(new Map());
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

    // Forget demand backoff for queue entries that no longer exist, so a
    // later requeue of the same target starts clean.
    const queuedKeys = useMessageQueueStore.getState().queuedMessages;
    for (const [key, record] of sendFailuresRef.current) {
      if (record.messageId === HYDRATE_DEMAND_FAILURE_ID && !(key in queuedKeys)) {
        sendFailuresRef.current.delete(key);
      }
    }

    const forgetHydrateDemand = (targetKey: string) => {
      if (sendFailuresRef.current.get(targetKey)?.messageId === HYDRATE_DEMAND_FAILURE_ID) {
        sendFailuresRef.current.delete(targetKey);
      }
    };

    // Cold-row demand: fetch authoritative lifecycle for a queued target
    // without selecting it or stealing directory focus. Missing, colliding,
    // archived, or disconnected targets get no demand (hydration cannot
    // resolve them), so those states hold without looping. Transient
    // failures retry on the shared bounded backoff instead of holding
    // forever or busy-looping.
    const demandLiveState = async (target: MessageQueueTarget, sessionId: string, targetKey: string) => {
      const storeState = store.getState();
      if (storeState.connection !== 'ready') return;
      const record = storeState.catalog.byId.get(sessionId);
      if (!record || record.archived || normalizePath(record.directory) !== normalizePath(target.directory)) return;

      // Terminal invalid session: the authoritative getSession already
      // confirmed this target no longer exists on the runtime, so another
      // hydrate can never succeed. Refuse the demand entirely — no request,
      // no backoff loop — and retain the queued entry for user
      // inspection/removal. SESSION_IN_USE and transient failures are not
      // terminal and keep the bounded backoff. A later successful reload
      // clears the recorded error, which resumes demands naturally.
      if (isInvalidSessionError(storeState.sessionLoadErrorById.get(sessionId))) return;

      // Backoff precedes the cold demand so a failing hydrate cannot loop.
      const hydrateFailure = sendFailuresRef.current.get(targetKey);
      if (
        hydrateFailure?.messageId === HYDRATE_DEMAND_FAILURE_ID
        && isQueuedAutoSendBackedOff(hydrateFailure, HYDRATE_DEMAND_FAILURE_ID, Date.now())
      ) {
        retryScheduler.schedule(hydrateFailure.nextAttemptAt);
        return;
      }
      // One in-flight demand per target; the guard is shared with sends and
      // released below with an explicit wake so nothing stays stranded.
      if (inFlightSessionsRef.current.has(targetKey)) return;
      inFlightSessionsRef.current.add(targetKey);
      try {
        await store.ensureHydrated(sessionId);
      } finally {
        inFlightSessionsRef.current.delete(targetKey);
        // Explicit wake: the hydration commit may have landed while this
        // pass held the guard, so the catalog emission alone may not
        // re-run the scanner.
        setRetryTick((value) => value + 1);
      }
      // `ensureHydrated` settles without rejecting even when hydration
      // fails, so success is verified from authoritative state, not the
      // promise outcome.
      const settledRecord = store.getState().catalog.byId.get(sessionId);
      if (settledRecord?.hydrated) {
        // Authoritative state arrived; send-failure records (real message
        // ids) stay untouched.
        forgetHydrateDemand(targetKey);
        return;
      }
      const priorFailures = hydrateFailure?.messageId === HYDRATE_DEMAND_FAILURE_ID ? hydrateFailure.failures : 0;
      const failures = priorFailures + 1;
      const nextAttemptAt = Date.now() + getQueuedAutoSendRetryDelayMs(failures);
      sendFailuresRef.current.set(targetKey, { messageId: HYDRATE_DEMAND_FAILURE_ID, failures, nextAttemptAt });
      retryScheduler.schedule(nextAttemptAt);
    };

    const dispatchSessionQueue = async (target: MessageQueueTarget, queueSnapshot: QueuedMessage[]) => {
      const { sessionId } = target;
      const targetKey = getMessageQueueKey(target);
      if (queueSnapshot.length === 0) {
        return;
      }
      // The queue entry may outlive a runtime switch; the current runtime
      // must own the dispatch (the Pi store itself is runtime-scoped, so a
      // stale target must never consult — or send into — the new runtime).
      if (target.runtimeKey !== getRuntimeKey()) {
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
      const storeState = store.getState();
      const readiness = resolveQueuedAutoSendReadiness(storeState, target);
      if (readiness === 'busy') {
        return;
      }
      if (readiness === 'unknown') {
        // The per-target queue may be edited or removed while the demand
        // awaits, so nothing is sent from here: the settle wake re-runs the
        // scanner, which re-reads live state and the queue before sending.
        await demandLiveState(target, sessionId, targetKey);
        return;
      }

      // Read the latest store at claim time — never the render-time snapshot —
      // and atomically mark sending before any await. A manual Send now claims
      // through the same store semantics, so the loser sees null and skips.
      // Persisted holds apply first: failed entries are skipped (they wait for
      // an explicit Steer and never block later entries), while an earlier
      // uncertain attempt or in-flight claim holds the whole queue (FIFO hold).
      const peeked = useMessageQueueStore.getState().getAutoSendCandidate(target);
      if (!peeked) {
        return;
      }

      const failure = sendFailuresRef.current.get(targetKey);
      if (failure && failure.messageId !== peeked.id && failure.messageId !== HYDRATE_DEMAND_FAILURE_ID) {
        sendFailuresRef.current.delete(targetKey);
      } else if (failure && failure.messageId !== HYDRATE_DEMAND_FAILURE_ID && isQueuedAutoSendBackedOff(failure, peeked.id, Date.now())) {
        // A held follow-up send never auto-retries an ambiguous transport
        // failure — recovery is Check status (uncertain) or an explicit Send
        // now (confirmed failure) from the chips.
        if (Number.isFinite(failure.nextAttemptAt)) {
          retryScheduler.schedule(failure.nextAttemptAt);
        }
        return;
      }

      const claimed = useMessageQueueStore.getState().claimQueuedMessage(target, peeked.id);
      if (!claimed) {
        return;
      }
      const payload = buildQueuedAutoSendPayload([claimed]);
      if (!payload) {
        useMessageQueueStore.getState().clearSending(target, claimed.id);
        return;
      }

      // Use send config captured at queue time as-is; fall back to current
      // config only for legacy queues that predate capture. A captured entry
      // without a variant stays variant-less — never falls back to the
      // mutable current variant.
      const captured = payload.sendConfig;
      const resolved = captured?.providerID && captured?.modelID
        ? captured
        : resolveSessionSendConfig(sessionId);
      if (!resolved.providerID || !resolved.modelID) {
        // Legacy queues may predate captured send configuration. Config
        // hydration is asynchronous, so retry instead of stranding the item
        // until an unrelated status or directory update happens. This retry
        // precedes any send, so it cannot duplicate an ambiguous delivery.
        // Release the claim so the retry re-claims from live state.
        useMessageQueueStore.getState().clearSending(target, claimed.id);
        retryScheduler.schedule(Date.now() + AUTO_SEND_RETRY_BASE_DELAY_MS);
        return;
      }

      inFlightSessionsRef.current.add(targetKey);
      // The claim above already published sending to the shared store, so a
      // manual Send now racing this dispatch sees null and skips. Record the
      // persisted attempt synchronously before the first await so a reload
      // holds instead of resending an uncertain delivery. The local ref only
      // guards concurrent hydration demands for this target.
      useMessageQueueStore.getState().markDeliveryAttempt(target, claimed.id, 'followUp');

      try {
        await sendQueuedAutoSendPayload(target, payload, {
          providerID: resolved.providerID,
          modelID: resolved.modelID,
          agent: resolved.agent,
          variant: resolved.variant,
        });
        // Remove ONLY the captured id after confirmed acceptance via the
        // completion path (the only remover allowed while claimed). Entries
        // queued during the await stay for their own distinct follow-up.
        useMessageQueueStore.getState().completeQueuedSend(target, payload.queuedMessageId);
        sendFailuresRef.current.delete(targetKey);
      } catch (error) {
        console.warn('[follow-up] auto-send failed:', error);
        // Ambiguous transport failures must NOT auto-retry: the send may
        // have reached the daemon despite the error, and a backoff retry
        // would duplicate the follow-up. Hold visibly instead.
        const priorFailures = failure?.messageId === payload.queuedMessageId ? failure.failures : 0;
        sendFailuresRef.current.set(targetKey, {
          messageId: payload.queuedMessageId,
          failures: priorFailures + 1,
          nextAttemptAt: Number.POSITIVE_INFINITY,
        });
        if (isQueuedSendUnconfirmedError(error)) {
          // Uncertain delivery: retain the persisted attempt and hold the
          // queue (FIFO). No cross-kind Steer resend — the receipt key
          // includes kind. Recovery is Check status from the chips.
          useMessageQueueStore.getState().markSendUnconfirmed(target, payload.queuedMessageId, 'followUp');
          toast.error('Follow-up status uncertain. Check status before retrying.', {
            id: `follow-up-unconfirmed:${targetKey}:${payload.queuedMessageId}`,
          });
        } else {
          // Confirmed rejection: clear the attempt, persist a fixed failure
          // label. No retry-loop; an explicit Steer may still claim it, and
          // later unrelated entries remain auto-sendable.
          useMessageQueueStore.getState().markSendFailed(target, payload.queuedMessageId);
          toast.error('Follow-up message failed to send. Use Send now to retry.', {
            id: `follow-up-failed:${targetKey}:${payload.queuedMessageId}`,
          });
        }
      } finally {
        inFlightSessionsRef.current.delete(targetKey);
        useMessageQueueStore.getState().clearSending(target, payload.queuedMessageId);
      }
    };

    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([key, queue]) => {
      const target = parseMessageQueueKey(key);
      // Deliberate scope: auto-send only serves the focused directory on the
      // current runtime. Queues for other directories wait for their own
      // focus; nothing steers or redirects them.
      if (!target || target.runtimeKey !== getRuntimeKey() || target.directory !== currentDirectory) return;
      if (queue.length === 0) return;
      void dispatchSessionQueue(target, queue);
    });
  }, [enabled, queuedMessages, currentDirectory, catalog, connection, retryTick, retryScheduler, store]);
}
