import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { AttachedFile } from './types/sessionTypes';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { piClient } from '@/lib/pi/client';
import { normalizePath } from '@/lib/pathNormalization';
import { deriveStableMessageId } from '@/lib/pi/send-intent';

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

export interface QueuedSendAuthority {
    /** Stable operation id for this queued entry (`qm:<queuedMessageId>`). */
    operationId: string;
    /** Stable message id derived from the operation id. */
    messageId: string;
    /** Verified stream epoch captured before upload. Held verbatim. Missing blocks auto-send. */
    streamEpoch?: string;
    /** Runtime the authority was captured under. Never replayed elsewhere. */
    runtimeKey: string;
    capturedAt: number;
    /** Owning session for cache scope. Reload must reuse the same session or block. */
    sessionId?: string;
    /** Exact text at capture. Reload must reuse verbatim or block. */
    text?: string;
    /** Exact send config at capture. Reload must reuse verbatim or block. */
    sendConfig?: {
        providerID: string;
        modelID: string;
        agent?: string;
        variant?: string;
    };
    /**
     * Exact resolved upload ids, all-or-nothing. Persisted before any first
     * dispatch (ready ids at queue time; fresh data ids after upload but
     * before prompt). Reload reuses verbatim or blocks — never skips
     * attachments or re-uploads under a dispatched id.
     */
    attachmentIds?: string[];
    /**
     * Explicit fresh-vs-dispatched marker. Fresh (`false`) entries were never
     * dispatched and may upload once through the normal route (persisting
     * resolved ids before dispatch). Dispatched (`true`) entries already left
     * the client under this op id — outcome uncertain after reload — so a
     * failed rehydration must block without fallthrough. Legacy entries omit
     * the flag and are treated as dispatched (uncertain) for safety.
     */
    dispatched?: boolean;
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
    /**
     * Captured send authority (epoch + intent identity). Persisted with the
     * queue so a reload cannot recapture a fresh epoch for the same operation
     * id. Entries without authority (legacy) must never auto-dispatch: the
     * original may already have executed, so automatic reexecution is
     * prohibited and an explicit new intent is required.
     */
    sendAuthority?: QueuedSendAuthority;
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

export const sanitizeQueuedAttachmentForPersist = (attachment: AttachedFile): AttachedFile => {
    const { file: _file, previewUrl: _preview, ...rest } = attachment as AttachedFile & { file?: unknown; previewUrl?: unknown };
    void _file;
    void _preview;
    // Ready uploads live on the server: persist only the opaque attachment id
    // metadata, never local bytes or preview URLs. Expired ids without bytes
    // block reexecution until the file is re-added (see routeMessage).
    if (rest.uploadState?.status === 'ready') {
        return { ...rest, dataUrl: '', previewUrl: undefined, file: undefined as unknown as File };
    }
    return { ...rest, previewUrl: undefined, file: undefined as unknown as File };
};

export const sanitizeQueuedMessageForPersist = (message: QueuedMessage): QueuedMessage => ({
    ...message,
    ...(message.attachments ? { attachments: message.attachments.map(sanitizeQueuedAttachmentForPersist) } : {}),
});

const sanitizeQueuedMessagesForPersist = (
    queues: Record<string, QueuedMessage[]>,
): Record<string, QueuedMessage[]> => {
    const next: Record<string, QueuedMessage[]> = {};
    for (const [key, messages] of Object.entries(queues)) {
        next[key] = messages.map(sanitizeQueuedMessageForPersist);
    }
    return next;
};

export const getPersistedMessageQueueStateForTests = (state: Pick<MessageQueueState, 'queuedMessages' | 'quarantinedLegacyMessages' | 'followUpBehavior'>) => ({
    queuedMessages: sanitizeQueuedMessagesForPersist(state.queuedMessages),
    quarantinedLegacyMessages: sanitizeQueuedMessagesForPersist(state.quarantinedLegacyMessages),
    followUpBehavior: state.followUpBehavior,
});

export const getMessageQueueKey = (target: MessageQueueTarget): string =>
    `${target.runtimeKey}\n${target.directory}\n${target.sessionId}`;

/**
 * Stable operation id for one queued send intent (finding #3). Canonical
 * owner: the queued entry owns the intent, so every dispatch and backed-off
 * retry of the same entry reuses the id and the daemon's execution boundary
 * deduplicates an accepted-but-unconfirmed send instead of producing two AI
 * responses. Never auto-mint a fresh id for an uncertain send: an explicit
 * new intent (`requeueWithNewIntent`, with a warning) is required.
 */
export const queuedSendOperationId = (queuedMessageId: string): string => `qm:${queuedMessageId}`;

export const parseMessageQueueKey = (key: string): MessageQueueTarget | null => {
    const [runtimeKey, directory, ...sessionParts] = key.split('\n');
    return createMessageQueueTarget(sessionParts.join('\n'), directory, runtimeKey);
};

interface MessageQueueState {
    queuedMessages: Record<string, QueuedMessage[]>; // runtime + directory + session → queue
    quarantinedLegacyMessages: Record<string, QueuedMessage[]>;
    followUpBehavior: FollowUpBehavior;
    /**
     * Queued messages whose send is currently awaiting the server, per target.
     *
     * A queued item is removed only after its send resolves, so between
     * dispatch and resolution it is still visible to every other reader — and
     * a composer submit merges the whole queue into its own send. Over a relay
     * that window is seconds, long enough for the same message to be delivered
     * twice. Dispatchers must skip entries listed here.
     *
     * Never persisted: a restart has no in-flight sends, and a stale flag would
     * strand a queued message permanently.
     */
    sendingIds: Record<string, string[]>;
}

interface MessageQueueActions {
    addToQueue: (target: MessageQueueTarget, message: Omit<QueuedMessage, 'id' | 'createdAt'>) => string;
    removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
    reorderQueue: (target: MessageQueueTarget, fromId: string, toId: string) => void;
    popToInput: (target: MessageQueueTarget, messageId: string) => QueuedMessage | null;
    clearQueue: (target: MessageQueueTarget) => void;
    clearAllQueues: () => void;
    markSending: (target: MessageQueueTarget, messageId: string) => void;
    clearSending: (target: MessageQueueTarget, messageId: string) => void;
    getSendableQueue: (target: MessageQueueTarget) => QueuedMessage[];
    setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
    getQueueForTarget: (target: MessageQueueTarget) => QueuedMessage[];
    /** Persist captured send authority for a queued entry (epoch + identity). */
    setQueuedSendAuthority: (target: MessageQueueTarget, messageId: string, authority: QueuedSendAuthority) => void;
    /**
     * Explicit new intent for a blocked/unknown queued send. Never called
     * automatically: the caller must have shown the duplicate warning and
     * captured the freshly verified current runtime/epoch authority (the
     * owning UI reads `getRuntimeKey()` + `getPiSessionStore().getStreamEpoch()`
     * and passes it explicitly; an omitted runtime falls back to the live
     * runtime key, an omitted epoch leaves the fresh authority epoch-less
     * so the auto-send gate waits for verification).
     * Copies content/config/valid attachments into a fresh queued entry with
     * a fresh id (hence fresh `queuedSendOperationId`) and a fresh authority
     * stamped with the current runtime key and verified epoch, using
     * `deriveStableMessageId` so the id matches routing exactly. Deliberately
     * current-runtime only: a target whose runtime differs from the verified
     * current runtime returns null and dispatches nothing. Removes the old
     * entry; drafts and other queued entries are preserved. The fresh entry
     * is auto-sendable after this explicit consent — no additional silent
     * new-id retry ever happens without it. Returns the new queued id.
     */
    requeueWithNewIntent: (
        target: MessageQueueTarget,
        messageId: string,
        explicitAuthority?: { runtimeKey?: string; streamEpoch?: string | null },
    ) => string | null;
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
                    const currentQueue = get().queuedMessages[key] ?? [];
                    if (currentQueue.length >= MAX_MESSAGES_PER_QUEUE) {
                        deleteUnusedQueuedAttachments(target, currentQueue.slice(0, currentQueue.length - MAX_MESSAGES_PER_QUEUE + 1));
                    }
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const queuedMessage: QueuedMessage = {
                        id,
                        content: message.content,
                        attachments: message.attachments,
                        createdAt: Date.now(),
                        sendConfig: message.sendConfig,
                        // Authority travels with the queue entry when the caller
                        // captured it (verified epoch + intent identity). Legacy
                        // callers omit it; those entries must never auto-dispatch
                        // after a reload (see the auto-send gate).
                        ...(message.sendAuthority ? { sendAuthority: message.sendAuthority } : {}),
                    };

                    set((state) => {
                        const currentQueue = state.queuedMessages[key] ?? [];
                        const queuedMessages = {
                            ...state.queuedMessages,
                            [key]: [...currentQueue, queuedMessage].slice(-MAX_MESSAGES_PER_QUEUE),
                        };
                        const keys = Object.keys(queuedMessages);
                        if (keys.length > MAX_QUEUE_TARGETS) {
                            keys.sort((left, right) => (
                                (queuedMessages[left]?.[0]?.createdAt ?? 0) - (queuedMessages[right]?.[0]?.createdAt ?? 0)
                            ));
                            for (const staleKey of keys.slice(0, keys.length - MAX_QUEUE_TARGETS)) delete queuedMessages[staleKey];
                        }
                        return {
                            queuedMessages,
                        };
                    });
                    return id;
                },

                setQueuedSendAuthority: (target, messageId, authority) => {
                    const key = getMessageQueueKey(target);
                    set((state) => {
                        const queue = state.queuedMessages[key];
                        if (!queue) return state;
                        const index = queue.findIndex((m) => m.id === messageId);
                        if (index < 0) return state;
                        const next = queue.slice();
                        next[index] = { ...next[index], sendAuthority: authority };
                        return { queuedMessages: { ...state.queuedMessages, [key]: next } };
                    });
                },

                removeFromQueue: (target, messageId) => {
                    const key = getMessageQueueKey(target);
                    const removed = (get().queuedMessages[key] ?? []).filter((message) => message.id === messageId);
                    deleteUnusedQueuedAttachments(target, removed);
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
                    deleteUnusedQueuedAttachments(target, (state.queuedMessages[key] ?? []).filter((message) => !sending.includes(message.id)));
                    set((state) => {
                        // Clearing drops what is still queued, never a message
                        // already handed to the server: that send will resolve
                        // and must find its entry to remove or restore.
                        const sending = state.sendingIds[key] ?? [];
                        const retained = (state.queuedMessages[key] ?? []).filter((m) => sending.includes(m.id));
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
                        if (target) deleteUnusedQueuedAttachments(target, messages);
                    }
                    set({ queuedMessages: {}, sendingIds: {} });
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

                requeueWithNewIntent: (target, messageId, explicitAuthority) => {
                    const key = getMessageQueueKey(target);
                    const current = get().queuedMessages[key] ?? [];
                    const existing = current.find((m) => m.id === messageId);
                    if (!existing) return null;
                    // Deliberately current-runtime only: never mint a fresh
                    // intent for an old runtime. The owning UI passes the
                    // verified current runtime/epoch explicitly (explicit
                    // dependency injection — the store never reads the session
                    // cluster itself, avoiding a store→apps import cycle).
                    // Without an explicit runtime the live runtime key is the
                    // fallback; without an explicit verified epoch the fresh
                    // authority carries no epoch and the auto-send gate waits
                    // for a verified epoch before dispatching.
                    let currentRuntimeKey = '';
                    try {
                        currentRuntimeKey = explicitAuthority?.runtimeKey ?? getRuntimeKey();
                    } catch {
                        currentRuntimeKey = target.runtimeKey;
                    }
                    if (!currentRuntimeKey || target.runtimeKey !== currentRuntimeKey) return null;
                    let verifiedEpoch: string | undefined;
                    if (explicitAuthority && 'streamEpoch' in explicitAuthority) {
                        verifiedEpoch = typeof explicitAuthority.streamEpoch === 'string' && explicitAuthority.streamEpoch.length > 0
                            ? explicitAuthority.streamEpoch
                            : undefined;
                    } else {
                        verifiedEpoch = undefined;
                    }
                    // Explicit new intent only: the old uncertain id is never
                    // reused. Warn so a possibly-executed send cannot silently
                    // duplicate; the user must have checked history first.
                    // A missing (legacy) or stale epoch never carries over:
                    // the fresh entry stamps the verified current epoch, so
                    // the auto-send gate unblocks only after this consent.
                    console.warn(
                        '[queue] creating an explicit new send intent for a blocked send; check history first to avoid a duplicate.',
                    );
                    const id = `queued-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                    const operationId = queuedSendOperationId(id);
                    const readyManifest = (() => {
                        const list = existing.attachments ?? [];
                        if (list.length === 0) return [] as string[];
                        const ids: string[] = [];
                        for (const attachment of list) {
                            const state = attachment.uploadState;
                            if (state?.status === 'ready' && state.expiresAt > Date.now()) {
                                ids.push(state.attachmentId);
                            } else {
                                return undefined;
                            }
                        }
                        return ids;
                    })();
                    const fresh: QueuedMessage = {
                        id,
                        content: existing.content,
                        ...(existing.attachments ? { attachments: existing.attachments } : {}),
                        createdAt: Date.now(),
                        ...(existing.sendConfig ? { sendConfig: { ...existing.sendConfig } } : {}),
                        sendAuthority: {
                            operationId,
                            messageId: deriveStableMessageId(operationId),
                            ...(verifiedEpoch ? { streamEpoch: verifiedEpoch } : {}),
                            runtimeKey: currentRuntimeKey,
                            capturedAt: Date.now(),
                            sessionId: target.sessionId,
                            text: existing.content,
                            ...(existing.sendConfig ? { sendConfig: { ...existing.sendConfig } } : {}),
                            ...(readyManifest ? { attachmentIds: [...readyManifest] } : {}),
                            dispatched: false,
                        },
                    };
                    set((state) => {
                        const queue = (state.queuedMessages[key] ?? []).filter((m) => m.id !== messageId);
                        const sending = state.sendingIds[key];
                        const nextSending = sending?.includes(messageId)
                            ? sending.filter((entryId) => entryId !== messageId)
                            : sending;
                        return {
                            queuedMessages: {
                                ...state.queuedMessages,
                                [key]: [...queue, fresh].slice(-MAX_MESSAGES_PER_QUEUE),
                            },
                            ...(nextSending !== sending
                                ? (nextSending && nextSending.length > 0
                                    ? { sendingIds: { ...state.sendingIds, [key]: nextSending } }
                                    : (() => {
                                        const { [key]: _removed, ...rest } = state.sendingIds;
                                        void _removed;
                                        return { sendingIds: rest };
                                    })())
                                : {}),
                        };
                    });
                    return id;
                },
            }),
            {
                name: 'message-queue-store',
                version: 2,
                storage: createDeferredSafeJSONStorage(),
                partialize: (state) => ({
                    queuedMessages: sanitizeQueuedMessagesForPersist(state.queuedMessages),
                    quarantinedLegacyMessages: sanitizeQueuedMessagesForPersist(state.quarantinedLegacyMessages),
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
