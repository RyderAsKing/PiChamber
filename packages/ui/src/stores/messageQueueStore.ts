import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { piClient } from '@/lib/pi/client';
import { normalizePath } from '@/lib/pathNormalization';

export type FollowUpBehavior = 'steer' | 'queue';

export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = 'queue';

export const isFollowUpBehavior = (value: unknown): value is FollowUpBehavior => (
    value === 'steer' || value === 'queue'
);

export const normalizeFollowUpBehavior = (
    value: unknown,
    legacyQueueModeEnabled?: boolean | null,
): FollowUpBehavior => {
    // "immediate" was removed: on a busy session it was wire-identical to
    // "steer" (Pi supports delivery "steer" | "queue", defaulting
    // to "steer"), so collapse any persisted/legacy "immediate" onto "steer".
    if (value === 'immediate') {
        return 'steer';
    }

    if (isFollowUpBehavior(value)) {
        return value;
    }

    if (legacyQueueModeEnabled === false) {
        return 'steer';
    }

    if (legacyQueueModeEnabled === true) {
        return 'queue';
    }

    return DEFAULT_FOLLOW_UP_BEHAVIOR;
};

export type QueuedDeliveryKind = 'prompt' | 'steer' | 'followUp';

export interface QueuedDeliveryAttempt {
    /** Delivery kind used for the uncertain send. The receipt key includes
     *  kind, so a retry across kinds cannot dedupe — recovery is Check status,
     *  never a cross-kind resend. */
    kind: QueuedDeliveryKind;
    /** Stable queue id used as operationId for the send. */
    operationId: string;
}

export interface QueuedMessage {
    id: string;
    content: string;
    attachments?: AttachedFile[];
    createdAt: number;
    /** Send config captured at queue time — used as-is when auto-sending */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
    /** Persisted uncertain-delivery marker. Set synchronously before any await
     *  that can deliver, so a reload holds auto-send instead of resending an
     *  ambiguous item. Cleared on confirmed rejection (see `sendFailed`) or
     *  on successful completion (entry removed). Retain on unconfirmed
     *  transport errors. New metadata is optional — existing v2 entries without
     *  it behave as before. */
    deliveryAttempt?: QueuedDeliveryAttempt;
    /** Persisted confirmed-rejection marker. Fixed state only — never a raw
     *  error string. Auto-send skips failed entries without retry-looping, but
     *  never blocks later unrelated entries in the same queue. An explicit
     *  user Steer may still claim a failed entry. */
    sendFailed?: boolean;
}

export type MessageQueueTarget = {
    runtimeKey: string;
    directory: string;
    sessionId: string;
};

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;

const deleteUnusedQueuedAttachments = (target: MessageQueueTarget, messages: readonly QueuedMessage[]): void => {
    if (target.runtimeKey !== getRuntimeKey()) return;
    const ids = messages.flatMap((message) => (message.attachments ?? []).flatMap((attachment) =>
        attachment.uploadState?.status === 'ready' ? [attachment.uploadState.attachmentId] : []));
    for (const id of new Set(ids)) {
        void piClient.deleteAttachment(id, { runtimeKey: target.runtimeKey }).catch(() => undefined);
    }
};

export const createMessageQueueTarget = (
    sessionId: string,
    directory: string | null | undefined,
    runtimeKey: string = getRuntimeKey(),
): MessageQueueTarget | null => {
    const normalizedDirectory = normalizePath(directory);
    if (!runtimeKey || !normalizedDirectory || !sessionId) return null;
    return { runtimeKey, directory: normalizedDirectory, sessionId };
};

export const getMessageQueueKey = (target: MessageQueueTarget): string =>
    `${target.runtimeKey}\n${target.directory}\n${target.sessionId}`;

export const parseMessageQueueKey = (key: string): MessageQueueTarget | null => {
    const [runtimeKey, directory, ...sessionParts] = key.split('\n');
    return createMessageQueueTarget(sessionParts.join('\n'), directory, runtimeKey);
};

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // runtime + directory + session → queue
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    /**
     * Follow-up messages whose send is currently awaiting the server, per target.
     *
     * A follow-up is removed only via `completeQueuedSend` after its send
     * resolves, so between dispatch and resolution it is still visible to
     * every other reader. Over a relay that window is seconds, long enough
     * for the same message to be delivered twice. Dispatchers must claim via
     * `claimQueuedMessage` (atomic mark before any await) and skip entries
     * listed here; normal submits never merge pending follow-ups. Persisted
     * `deliveryAttempt` is the reload-durable hold; this map is the transient
     * UI claim (Sending indicator, edit/remove/send guard).
     *
     * Never persisted: a restart has no in-flight sends, and a stale flag would
     * strand a follow-up permanently. The persisted attempt marker covers reload.
     */
    sendingIds: Record<string, string[]>;
}

interface MessageQueueActions {
    /**
     * Bounded enqueue: returns true on success, false when the per-target
     * (20) or global target (50) capacity is full. Rejection happens before
     * any mutation with no side effects — existing in-flight/uncertain
     * entries and their attachments are never evicted. Callers preserve the
     * composer draft and surface the limit; never throws.
     */
    addToQueue: (target: MessageQueueTarget, message: Omit<QueuedMessage, 'id' | 'createdAt' | 'deliveryAttempt' | 'sendFailed'>) => boolean;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    popToInput: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    clearQueue: (target: MessageQueueTarget) => void;
    clearAllQueues: () => void;
    markSending: (target: MessageQueueTarget, messageId: string) => void;
    clearSending: (target: MessageQueueTarget, messageId: string) => void;
    /**
     * Record a persisted uncertain-delivery attempt before any await that can
     *  deliver. Kind + stable operationId (the queue id) survive reload so the
     *  auto scanner holds instead of resending. Clears any prior confirmed
     *  failure: a new explicit attempt supersedes the old label. Synchronous —
     *  call before the first await of the send. A conservative reload hold
     *  (attempt recorded but send never reached the server) is acceptable.
     *  Durability is best-effort deferred persistence (createDeferredSafeJSONStorage
     *  flushes on a timer plus pagehide/beforeunload/hidden/freeze): safeStorage
     *  exposes no synchronous flush helper, so no additional flush is performed
     *  here and no new persistence abstraction is introduced.
     */
    markDeliveryAttempt: (target: MessageQueueTarget, messageId: string, kind: QueuedDeliveryKind) => void;
    /**
     * Record a confirmed rejection: clears the uncertain attempt, persists a
     *  fixed failure label. Auto-send skips the entry without retry-looping;
     *  an explicit user Steer may still claim it.
     */
    markSendFailed: (target: MessageQueueTarget, messageId: string) => void;
    /**
     * Retain the uncertain attempt after a PiSendUnconfirmedError. Ensures an
     *  attempt exists (same kind) so reload holds; never sets the failure
     *  label and never replays the send.
     */
    markSendUnconfirmed: (target: MessageQueueTarget, messageId: string, kind: QueuedDeliveryKind) => void;
    /**
     * Remove a claimed entry after confirmed acceptance and release its
     *  transient sending claim atomically. The only path that may remove an
     *  entry while it is claimed sending; `removeFromQueue`/`popToInput`
     *  refuse claimed ids so pending uploads cannot be discarded.
     */
    completeQueuedSend: (target: MessageQueueTarget, messageId: string) => void;
    /**
     * Atomically claim one pending follow-up for delivery.
     *
     * Reads the latest store (never a stale React snapshot) and marks the
     * entry sending in the same synchronous pass, before any await. A second
     * claimant for the same id — manual Send now vs auto-send — gets null,
     * so the same follow-up is never delivered twice. Refuses ids that are
     * already sending or that carry a persisted uncertain attempt (Check
     * status first — never a cross-kind resend). A persisted confirmed
     * failure does NOT block a claim: explicit user Steer may retry it.
     * Returns the captured entry with its queue-time configuration as-is.
     */
    claimQueuedMessage: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    /**
     * Oldest auto-sendable entry for a target, or null when the scanner must
     *  hold. Skips persisted confirmed failures (they wait for an explicit
     *  Steer and never block unrelated later entries) but holds the whole
     *  queue behind an earlier transient sending claim or persisted uncertain
     *  attempt (FIFO hold — safe against duplication/reorder). Reads the
     *  latest store; call before `claimQueuedMessage`.
     */
    getAutoSendCandidate: (target: MessageQueueTarget) => QueuedMessage | null;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
}

type MessageQueueStore = MessageQueueState & MessageQueueActions;

type PersistedMessageQueueState = {
    queuedMessages?: Record<string, QueuedMessage[]>;
    quarantinedLegacyMessages?: Record<string, QueuedMessage[]>;
    followUpBehavior?: FollowUpBehavior;
    queueModeEnabled?: boolean;
};

export const migrateMessageQueueState = (persistedState: unknown, version: number): Partial<MessageQueueStore> => {
    const state = (persistedState ?? {}) as PersistedMessageQueueState;
    const legacyQueues = version < 2 ? (state.queuedMessages ?? {}) : {};
    return {
        queuedMessages: version < 2 ? {} : (state.queuedMessages ?? {}),
        quarantinedLegacyMessages: {
            ...(state.quarantinedLegacyMessages ?? {}),
            ...legacyQueues,
        },
        followUpBehavior: normalizeFollowUpBehavior(state.followUpBehavior, state.queueModeEnabled ?? null),
    };
};

export const useMessageQueueStore = create<MessageQueueStore>()(
    devtools(
        persist(
            (set, get) => ({
                queuedMessages: {},
                quarantinedLegacyMessages: {},
                followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
                sendingIds: {},

                addToQueue: (target, message) => {
                    const key = getMessageQueueKey(target);
                    const snapshot = get();
                    const snapshotQueue = snapshot.queuedMessages[key] ?? [];
                    if (snapshotQueue.length >= MAX_MESSAGES_PER_QUEUE) return false;
                    if (!(key in snapshot.queuedMessages) && Object.keys(snapshot.queuedMessages).length >= MAX_QUEUE_TARGETS) return false;
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                    };

                    let accepted = false;
                    set((state) => {
                        const currentQueue = state.queuedMessages[key] ?? [];
                        if (currentQueue.length >= MAX_MESSAGES_PER_QUEUE) return state;
                        if (!(key in state.queuedMessages) && Object.keys(state.queuedMessages).length >= MAX_QUEUE_TARGETS) return state;
                        accepted = true;
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: [...currentQueue, queuedMessage],
                            },
                        };
                    });
                    return accepted;
                },

                removeFromQueue: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    // Latest-store guard: never discard an entry with uploads
                    // while its send is pending. Success uses completeQueuedSend.
                    if ((get().sendingIds[key] ?? []).includes(messageId)) return;
                    const removed = (get().queuedMessages[key] ?? []).filter((message) => message.id === messageId);
                    // Explicit user removal drops local display but never deletes
                    // potential SDK bytes for an uncertain delivery: only ordinary
                    // entries (no persisted attempt) may delete uploads.
                    deleteUnusedQueuedAttachments(target, removed.filter((message) => !message.deliveryAttempt));
                    set((state) => {
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const newQueue = currentQueue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [key]: _removed, ...rest } = state.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: newQueue,
                            },
                        };
                    });
                },

                reorderQueue: (target, fromId, toId) => {
                    if (fromId === toId) return;
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const currentQueue = state.queuedMessages[key];
                        if (!currentQueue) return state;
                        const fromIndex = currentQueue.findIndex((m) => m.id === fromId);
                        const toIndex = currentQueue.findIndex((m) => m.id === toId);
                        if (fromIndex === -1 || toIndex === -1) return state;

                        const newQueue = currentQueue.slice();
                        const [moved] = newQueue.splice(fromIndex, 1);
                        newQueue.splice(toIndex, 0, moved);

                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: newQueue,
                            },
                        };
                    });
                },

                popToInput: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    // Latest-store guard: editing pops the entry back into the
                    // composer with its uploads. Refuse while sending so pending
                    // uploads cannot be discarded mid-request.
                    if ((state.sendingIds[key] ?? []).includes(messageId)) {
                        return null;
                    }
                    const currentQueue = state.queuedMessages[key] ?? [];
                    const message = currentQueue.find((m) => m.id === messageId);
                    
                    if (!message) {
                        return null;
                    }

                    // Remove from queue
                    set((prevState) => {
                        const queue = prevState.queuedMessages[key] ?? [];
                        const newQueue = queue.filter((m) => m.id !== messageId);
                        
                        if (newQueue.length === 0) {
                            const { [key]: _removed, ...rest } = prevState.queuedMessages;
                            void _removed;
                            return { queuedMessages: rest };
                        }
                        
                        return {
                            queuedMessages: {
                                ...prevState.queuedMessages,
                                    [key]: newQueue,
                            },
                        };
                    });

                    return message;
                },

                clearQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    const sending = state.sendingIds[key] ?? [];
                    // Clearing drops ordinary queued display only. In-flight and
                    // uncertain entries are retained and their potential SDK
                    // attachments are never deleted.
                    deleteUnusedQueuedAttachments(target, (state.queuedMessages[key] ?? []).filter((message) => !sending.includes(message.id) && !message.deliveryAttempt));
                    set((state) => {
                        // Clearing drops what is still queued, never a message
                        // already handed to the server or an uncertain delivery:
                        // that send will resolve and must find its entry to remove
                        // or restore. Uncertain attempts hold for Check status.
                        const sending = state.sendingIds[key] ?? [];
                        const retained = (state.queuedMessages[key] ?? []).filter((m) => sending.includes(m.id) || m.deliveryAttempt);
                        if (retained.length > 0) {
                            return { queuedMessages: { ...state.queuedMessages, [key]: retained } };
                        }
                        const { [key]: _removed, ...rest } = state.queuedMessages;
                        void _removed;
                        return { queuedMessages: rest };
                    });
                },

                clearAllQueues: () => {
                    const state = get();
                    for (const [key, messages] of Object.entries(state.queuedMessages)) {
                        const target = parseMessageQueueKey(key);
                        if (!target) continue;
                        const sending = state.sendingIds[key] ?? [];
                        // Never delete potential SDK attachments for in-flight or
                        // uncertain entries; only ordinary removed display entries.
                        const toRemove = messages.filter((message) => !sending.includes(message.id) && !message.deliveryAttempt);
                        if (toRemove.length > 0) deleteUnusedQueuedAttachments(target, toRemove);
                    }
                    set((state) => {
                        // Retain in-flight and uncertain entries across all targets;
                        // drop only ordinary queued display. Retained sending claims stay.
                        const nextQueued: Record<string, QueuedMessage[]> = {};
                        const nextSending: Record<string, string[]> = {};
                        for (const [key, messages] of Object.entries(state.queuedMessages)) {
                            const sending = state.sendingIds[key] ?? [];
                            const retained = messages.filter((message) => sending.includes(message.id) || message.deliveryAttempt);
                            if (retained.length > 0) {
                                nextQueued[key] = retained;
                                const retainedSending = sending.filter((id) => retained.some((message) => message.id === id));
                                if (retainedSending.length > 0) nextSending[key] = retainedSending;
                            }
                        }
                        return { queuedMessages: nextQueued, sendingIds: nextSending };
                    });
                },

                markSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.sendingIds[key] ?? [];
                        if (current.includes(messageId)) return state;
                        return { sendingIds: { ...state.sendingIds, [key]: [...current, messageId] } };
                    });
                },

                clearSending: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const current = state.sendingIds[key];
                        if (!current || !current.includes(messageId)) return state;
                        const next = current.filter((id) => id !== messageId);
                        if (next.length === 0) {
                            const { [key]: _removed, ...rest } = state.sendingIds;
                            void _removed;
                            return { sendingIds: rest };
                        }
                        return { sendingIds: { ...state.sendingIds, [key]: next } };
                    });
                },

                markDeliveryAttempt: (target, messageId, kind) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const queue = state.queuedMessages[key];
                        if (!queue) return state;
                        const index = queue.findIndex((message) => message.id === messageId);
                        if (index === -1) return state;
                        const current = queue[index];
                        const existing = current.deliveryAttempt;
                        if (existing?.kind === kind && existing?.operationId === messageId && !current.sendFailed) return state;
                        const nextQueue = queue.slice();
                        nextQueue[index] = {
                            ...current,
                            deliveryAttempt: { kind, operationId: messageId },
                            sendFailed: undefined,
                        };
                        return { queuedMessages: { ...state.queuedMessages, [key]: nextQueue } };
                    });
                },

                markSendFailed: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const queue = state.queuedMessages[key];
                        if (!queue) return state;
                        const index = queue.findIndex((message) => message.id === messageId);
                        if (index === -1) return state;
                        const current = queue[index];
                        if (current.sendFailed === true && !current.deliveryAttempt) return state;
                        const nextQueue = queue.slice();
                        const { deliveryAttempt: _dropped, ...rest } = current;
                        void _dropped;
                        nextQueue[index] = { ...rest, sendFailed: true };
                        return { queuedMessages: { ...state.queuedMessages, [key]: nextQueue } };
                    });
                },

                markSendUnconfirmed: (target, messageId, kind) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const queue = state.queuedMessages[key];
                        if (!queue) return state;
                        const index = queue.findIndex((message) => message.id === messageId);
                        if (index === -1) return state;
                        const current = queue[index];
                        if (current.deliveryAttempt) return state;
                        const nextQueue = queue.slice();
                        nextQueue[index] = {
                            ...current,
                            deliveryAttempt: { kind, operationId: messageId },
                        };
                        return { queuedMessages: { ...state.queuedMessages, [key]: nextQueue } };
                    });
                },

                completeQueuedSend: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    const removed = (get().queuedMessages[key] ?? []).filter((message) => message.id === messageId);
                    // Completion owns its uploads: the daemon accepted them.
                    // No attachment delete — they are now part of the turn.
                    void removed;
                    set((state) => {
                        const queue = state.queuedMessages[key] ?? [];
                        const newQueue = queue.filter((m) => m.id !== messageId);
                        const sending = state.sendingIds[key];
                        const nextSending = sending?.includes(messageId)
                            ? sending.filter((id) => id !== messageId)
                            : sending;
                        const nextState: Partial<MessageQueueStore> = {};
                        if (newQueue.length === 0) {
                            if (key in state.queuedMessages) {
                                const { [key]: _removed, ...rest } = state.queuedMessages;
                                void _removed;
                                nextState.queuedMessages = rest;
                            }
                        } else if (newQueue.length !== queue.length) {
                            nextState.queuedMessages = { ...state.queuedMessages, [key]: newQueue };
                        }
                        if (nextSending !== sending) {
                            if (!nextSending || nextSending.length === 0) {
                                const { [key]: _removed, ...rest } = state.sendingIds;
                                void _removed;
                                nextState.sendingIds = rest;
                            } else {
                                nextState.sendingIds = { ...state.sendingIds, [key]: nextSending };
                            }
                        }
                        return Object.keys(nextState).length > 0 ? nextState : state;
                    });
                },

                claimQueuedMessage: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    let claimed: QueuedMessage | null = null;
                    set((state) => {
                        const queue = state.queuedMessages[key] ?? [];
                        const sending = state.sendingIds[key] ?? [];
                        if (sending.includes(messageId)) return state;
                        const found = queue.find((message) => message.id === messageId);
                        if (!found) return state;
                        // An uncertain attempt holds: Check status first. A
                        // cross-kind resend cannot dedupe (receipt key includes
                        // kind). A confirmed failure does not block an explicit claim.
                        if (found.deliveryAttempt) return state;
                        claimed = found;
                        return { sendingIds: { ...state.sendingIds, [key]: [...sending, messageId] } };
                    });
                    return claimed;
                },

                getAutoSendCandidate: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    const queue = state.queuedMessages[key] ?? [];
                    const sending = state.sendingIds[key] ?? [];
                    for (const message of queue) {
                        // FIFO hold: an earlier uncertain or in-flight delivery
                        // blocks later entries to preserve order and avoid
                        // duplicating an ambiguous send. Safe by intent.
                        if (sending.includes(message.id)) return null;
                        if (message.deliveryAttempt) return null;
                        // A confirmed failure waits for an explicit Steer and
                        // never blocks unrelated later entries.
                        if (message.sendFailed === true) continue;
                        return message;
                    }
                    return null;
                },

                getSendableQueue: (target) => {
                    const key = getMessageQueueKey(target);
                    const state = get();
                    const queue = state.queuedMessages[key] ?? [];
                    const sending = state.sendingIds[key];
                    if (!sending || sending.length === 0) return queue;
                    return queue.filter((message) => !sending.includes(message.id));
                },

                setFollowUpBehavior: (behavior) => {
                    set({ followUpBehavior: behavior });
                    void updateDesktopSettings({ followUpBehavior: behavior });
                },

                getQueueForTarget: (target) => {
                    return get().queuedMessages[getMessageQueueKey(target)] ?? [];
                },
            }),
            {
                name: 'message-queue-store',
                version: 2,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    queuedMessages: state.queuedMessages,
                    quarantinedLegacyMessages: state.quarantinedLegacyMessages,
                    followUpBehavior: state.followUpBehavior,
                }),
                migrate: migrateMessageQueueState,
            }
        ),
        {
            name: 'message-queue-store',
        }
    )
);
