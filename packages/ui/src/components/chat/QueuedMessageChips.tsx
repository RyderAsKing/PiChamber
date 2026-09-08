import React, { memo } from 'react';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    closestCenter,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { getQueuedAutoSendBlockedReason } from '@/hooks/useQueuedMessageAutoSend';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface QueuedMessageChipProps {
    message: QueuedMessage;
    target: MessageQueueTarget;
    onEdit: (message: QueuedMessage) => void;
    onSend: (message: QueuedMessage) => void;
}

const QueuedMessageChip = memo(({ message, target, onEdit, onSend }: QueuedMessageChipProps) => {
    const removeFromQueue = useMessageQueueStore((state) => state.removeFromQueue);
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: message.id });

    // Get first line of message, truncated
    const firstLine = React.useMemo(() => {
        const lines = message.content.split('\n');
        const first = lines[0] || '';
        const maxLength = 100;
        if (first.length > maxLength) {
            return first.substring(0, maxLength) + '...';
        }
        return first + (lines.length > 1 ? '...' : '');
    }, [message.content]);

    const attachmentCount = message.attachments?.length ?? 0;

    return (
        <div
            ref={setNodeRef}
            // Translate only (no scaleX/scaleY) so the lifted row keeps its size.
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={cn('flex min-w-0 items-center gap-2 py-1', isDragging && 'z-10 opacity-60')}
        >
            <button
                type="button"
                {...attributes}
                {...listeners}
                className="flex flex-shrink-0 cursor-grab touch-none select-none items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
                aria-label={"Drag to reorder"}
            >
                <Icon name="draggable" className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                {firstLine || "(empty)"}
                {attachmentCount > 0 && (
                    <span className="ml-1 text-muted-foreground">{attachmentCount === 1 ? `+1 file` : `+${attachmentCount} files`}</span>
                )}
            </span>
            <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => onEdit(message)}
            >
                <Icon name="edit" className="h-3 w-3" aria-hidden="true" />
                {"edit"}
            </Button>
            <Button
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => onSend(message)}
            >
                <Icon name="send-plane" className="h-3 w-3" aria-hidden="true" />
                {"send"}
            </Button>
            <button
                type="button"
                onClick={() => removeFromQueue(target, message.id)}
                className="flex items-center justify-center h-6 w-6 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                aria-label={"Remove from queue"}
            >
                <Icon name="close" className="h-4 w-4 text-muted-foreground" />
            </button>
        </div>
    );
});

QueuedMessageChip.displayName = 'QueuedMessageChip';

const blockedReasonCopy = (reason: string): string => {
    if (reason === 'runtime-mismatch') {
        return 'Belongs to a different runtime. It will never send here automatically and will not switch runtimes. Check history, then send as new if needed.';
    }
    if (reason === 'stale-epoch') {
        return 'The server restarted after this was queued. The original may already have run. Check history first. Sending again may duplicate.';
    }
    if (reason === 'operation-mismatch') {
        return 'Send identity does not match. The original may already have run. Check history before sending as new. It will not send automatically.';
    }
    return 'Saved before send confirmation. It may already have been sent. Check history before sending as new. It will not send automatically.';
};

const BlockedQueueWarning = memo(({ reason, onSendAsNew }: { reason: string; onSendAsNew: () => void }) => (
    <div
        role="alert"
        className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-2.5 py-2"
    >
        <p className="typography-ui-label text-foreground">{blockedReasonCopy(reason)}</p>
        <p className="typography-meta mt-1 text-muted-foreground">Sending again may duplicate.</p>
        <div className="mt-2 flex justify-end">
            <Button type="button" variant="outline" size="xs" onClick={onSendAsNew}>
                <Icon name="restart" className="h-3 w-3" aria-hidden="true" />
                Send as new
            </Button>
        </div>
    </div>
));

BlockedQueueWarning.displayName = 'BlockedQueueWarning';

export const SendStateNotice = memo(({ sessionId }: { sessionId: string }) => {
    // Subscribe to the collection, then look the id up in the body so a
    // selector closing over the id cannot return a stale entity.
    const sendStateById = usePiSessionSnapshot(
        React.useCallback((state) => state.sendStateById, []),
        undefined,
        `session:${sessionId}`,
    );
    const sendState = sendStateById.get(sessionId);
    const [checking, setChecking] = React.useState(false);

    const handleCheckStatus = React.useCallback(async () => {
        if (checking) return;
        setChecking(true);
        try {
            await getPiSessionStore().refreshSendConfirmation(sessionId);
        } finally {
            setChecking(false);
        }
    }, [checking, sessionId]);

    const handleSendAsNew = React.useCallback(() => {
        // Explicit confirmation only: mints a fresh operation id and clears
        // the unknown record. The preserved composer draft still needs an
        // explicit send — nothing is replayed automatically.
        getPiSessionStore().beginNewSendIntentAfterUnknown(sessionId);
    }, [sessionId]);

    const handleDismiss = React.useCallback(() => {
        getPiSessionStore().clearSendState(sessionId);
    }, [sessionId]);

    if (!sendState) return null;

    if (sendState.status === 'confirming') {
        const runtimeMismatch = (() => {
            try {
                return sendState.runtimeKey !== getRuntimeKey();
            } catch {
                return false;
            }
        })();
        return (
            <div
                role="status"
                className="rounded-xl border border-[var(--status-info-border)] bg-[var(--status-info-background)] px-3 py-2.5"
            >
                <div className="flex items-start gap-2">
                    <Icon name="information" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-info)]" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="typography-ui-label font-medium text-foreground">{sendState.title}</p>
                        <p className="typography-ui-label mt-0.5 text-muted-foreground">{sendState.action}</p>
                        {runtimeMismatch ? (
                            <p className="typography-meta mt-1 text-muted-foreground">This send belongs to a different runtime and will not continue here.</p>
                        ) : null}
                    </div>
                </div>
                <div className="mt-2 flex justify-end">
                    <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => void handleCheckStatus()}
                        disabled={checking || runtimeMismatch}
                        aria-label="Check send status without resending"
                    >
                        <Icon name="refresh" className="h-3 w-3" aria-hidden="true" />
                        {checking ? 'Checking…' : 'Check status'}
                    </Button>
                </div>
            </div>
        );
    }

    if (sendState.status === 'outcome-unknown') {
        return (
            <div
                role="alert"
                className="rounded-xl border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2.5"
            >
                <div className="flex items-start gap-2">
                    <Icon name="error-warning" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="typography-ui-label font-medium text-foreground">{sendState.title}</p>
                        <p className="typography-ui-label mt-0.5 text-muted-foreground">{sendState.action}</p>
                        <p className="typography-meta mt-1 text-muted-foreground">Sending again may duplicate. Check history first.</p>
                    </div>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                    <Button type="button" variant="outline" size="xs" onClick={handleDismiss}>
                        Dismiss
                    </Button>
                    <Button type="button" variant="default" size="xs" onClick={handleSendAsNew}>
                        <Icon name="restart" className="h-3 w-3" aria-hidden="true" />
                        Send as new
                    </Button>
                </div>
            </div>
        );
    }

    if (sendState.status === 'rejected') {
        return (
            <div
                role="alert"
                className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2.5"
            >
                <div className="flex items-start gap-2">
                    <Icon name="error-warning" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-error)]" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="typography-ui-label font-medium text-foreground">{sendState.title}</p>
                        <p className="typography-ui-label mt-0.5 text-muted-foreground">{sendState.action}</p>
                    </div>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                    <Button type="button" variant="outline" size="xs" onClick={handleDismiss}>
                        Dismiss
                    </Button>
                    <Button type="button" variant="default" size="xs" onClick={handleSendAsNew}>
                        <Icon name="restart" className="h-3 w-3" aria-hidden="true" />
                        Send as new
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div
            role="status"
            className="rounded-xl border border-[var(--status-success-border)] bg-[var(--status-success-background)] px-3 py-2.5"
        >
            <div className="flex items-start gap-2">
                <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-success)]" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <p className="typography-ui-label font-medium text-foreground">{sendState.title}</p>
                    <p className="typography-ui-label mt-0.5 text-muted-foreground">{sendState.action}</p>
                </div>
            </div>
            <div className="mt-2 flex justify-end">
                <Button type="button" variant="outline" size="xs" onClick={handleDismiss}>
                    Dismiss
                </Button>
            </div>
        </div>
    );
});

SendStateNotice.displayName = 'SendStateNotice';

interface QueuedMessageChipsProps {
    onEditMessage: (content: string, attachments?: QueuedMessage['attachments']) => void;
    onSendMessage: (messageId: string) => void;
}

const EMPTY_QUEUE: QueuedMessage[] = [];

export const QueuedMessageChips = memo(({ onEditMessage, onSendMessage }: QueuedMessageChipsProps) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    // Must use the same resolution the composer used to build the queue key —
    // reading currentSessionDirectory raw can key the chips to a different
    // directory than the one the messages were queued under.
    const currentSessionDirectory = useSessionUIStore(
        React.useCallback(
            (state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null),
            [currentSessionId],
        ),
    );
    const target = currentSessionId ? createMessageQueueTarget(currentSessionId, currentSessionDirectory) : null;
    const queueKey = target ? getMessageQueueKey(target) : null;
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!queueKey) return EMPTY_QUEUE;
                return state.queuedMessages[queueKey] ?? EMPTY_QUEUE;
            },
            [queueKey]
        )
    );
    const popToInput = useMessageQueueStore((state) => state.popToInput);
    const reorderQueue = useMessageQueueStore((state) => state.reorderQueue);
    const requeueWithNewIntent = useMessageQueueStore((state) => state.requeueWithNewIntent);
    // Visibility for the send notice when the queue itself is empty. Leaf
    // map subscription only; the notice component owns the record read.
    const sendStateByIdForVisibility = usePiSessionSnapshot(
        React.useCallback((state) => state.sendStateById, []),
        undefined,
        currentSessionId ? `session:${currentSessionId}` : 'chrome',
    );
    const hasSendNotice = currentSessionId ? sendStateByIdForVisibility.has(currentSessionId) : false;
    // Re-evaluate blocked reasons when reconnect recovery flips (a verified
    // epoch change is what turns a queued authority stale). The selector is
    // a leaf string, so unrelated chrome commits do not wake this list.
    usePiSessionSnapshot(
        React.useCallback((state) => state.syncReadiness, []),
        undefined,
        'chrome',
    );

    const sensors = useSensors(
        // Desktop: drag after a small move so other clicks still register.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Touch: long-press to drag (tap still hits buttons, swipe scrolls).
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    );

    const handleDragEnd = React.useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id || !target) return;
        reorderQueue(target, String(active.id), String(over.id));
    }, [target, reorderQueue]);

    const handleEdit = React.useCallback((message: QueuedMessage) => {
        if (!target) return;
        const popped = popToInput(target, message.id);
        if (popped) {
            if (popped.attachments && popped.attachments.length > 0) {
                const currentAttachments = useInputStore.getState().attachedFiles;
                useInputStore.getState().setAttachedFiles([...currentAttachments, ...popped.attachments]);
            }
            onEditMessage(popped.content, popped.attachments);
        }
    }, [target, popToInput, onEditMessage]);

    const handleSend = React.useCallback((message: QueuedMessage) => {
        onSendMessage(message.id);
    }, [onSendMessage]);

    const blockedById = React.useMemo(() => {
        if (!target || queuedMessages.length === 0) return new Map<string, string>();
        let currentEpoch: string | null = null;
        try {
            currentEpoch = getPiSessionStore().getStreamEpoch?.() ?? null;
        } catch {
            currentEpoch = null;
        }
        let currentRuntimeKey = '';
        try {
            currentRuntimeKey = getRuntimeKey();
        } catch {
            currentRuntimeKey = target.runtimeKey;
        }
        const next = new Map<string, string>();
        for (const message of queuedMessages) {
            const reason = getQueuedAutoSendBlockedReason(message, target, currentRuntimeKey, currentEpoch);
            if (reason !== null) next.set(message.id, reason);
        }
        return next;
    }, [target, queuedMessages]);

    const handleSendAsNew = React.useCallback((messageId: string) => {
        if (!target) return;
        // Explicit duplicate-warning consent only: captures the freshly
        // verified current runtime/epoch authority from the owning stores and
        // mints a fresh intent. The fresh entry becomes auto-sendable after
        // this consent; no silent new-id retry ever happens without it. The
        // store enforces current-runtime only and drops the old uncertain id.
        let runtimeKey: string | undefined;
        try {
            runtimeKey = getRuntimeKey();
        } catch {
            runtimeKey = undefined;
        }
        let streamEpoch: string | null = null;
        try {
            streamEpoch = getPiSessionStore().getStreamEpoch?.() ?? null;
        } catch {
            streamEpoch = null;
        }
        requeueWithNewIntent(target, messageId, {
            ...(runtimeKey ? { runtimeKey } : {}),
            streamEpoch,
        });
    }, [target, requeueWithNewIntent]);

    const hasQueue = target !== null && queuedMessages.length > 0;
    if (!currentSessionId) return null;
    if (!hasQueue && !hasSendNotice) return null;
    if (!hasQueue) {
        return (
            <div className="pb-2 w-full px-1">
                <SendStateNotice sessionId={currentSessionId} />
            </div>
        );
    }

    return (
        <div className="pb-2 w-full px-1">
            <div className="flex flex-col gap-2">
                <SendStateNotice sessionId={currentSessionId} />
            </div>
            <div className="mt-2 rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
                <div className="flex w-full items-center gap-2 px-3 py-2 text-left">
                    <span className="typography-ui-label font-medium text-foreground flex-shrink-0">
                        {"Queued messages"} {queuedMessages.length}
                    </span>
                    <Icon name="time" className="ml-auto h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext
                        items={queuedMessages.map((m) => m.id)}
                        strategy={verticalListSortingStrategy}
                    >
                        <div className="px-3 pb-3 flex flex-col gap-1.5 max-h-[10.5rem] overflow-y-auto">
                            {queuedMessages.map((message) => {
                                const blockedReason = blockedById.get(message.id) ?? null;
                                return (
                                    <div key={message.id} className="flex flex-col gap-1.5">
                                        <QueuedMessageChip
                                            message={message}
                                            target={target}
                                            onEdit={handleEdit}
                                            onSend={handleSend}
                                        />
                                        {blockedReason !== null ? (
                                            <BlockedQueueWarning reason={blockedReason} onSendAsNew={() => handleSendAsNew(message.id)} />
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                    </SortableContext>
                </DndContext>
            </div>
        </div>
    );
});

QueuedMessageChips.displayName = 'QueuedMessageChips';
