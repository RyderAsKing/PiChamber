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
import { queryQueuedSendReceipt } from '@/stores/queuedSendReceipt';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { useInputStore } from '@/sync/input-store';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';

interface QueuedMessageChipProps {
    message: QueuedMessage;
    target: MessageQueueTarget;
    sending: boolean;
    checking: boolean;
    onEdit: (message: QueuedMessage) => void;
    onSend: (message: QueuedMessage) => void;
    onCheck: (message: QueuedMessage) => void;
}

const QueuedMessageChip = memo(({ message, target, sending, checking, onEdit, onSend, onCheck }: QueuedMessageChipProps) => {

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
    const attempted = message.deliveryAttempt !== undefined;
    const failed = message.sendFailed === true;
    const busy = sending || checking;

    return (
        <div
            ref={setNodeRef}
            // Translate only (no scaleX/scaleY) so the lifted row keeps its size.
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={cn('flex min-w-0 flex-col gap-1 py-1', isDragging && 'z-10 opacity-60')}
        >
            <div className="flex min-w-0 items-center gap-2">
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
                        <span className="ml-1 text-muted-foreground">{attachmentCount === 1 ? "+1 file" : `+${attachmentCount} files`}</span>
                    )}
                </span>
                <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => onEdit(message)}
                    disabled={busy}
                >
                    <Icon name="edit" className="h-3 w-3" aria-hidden="true" />
                    {"Edit"}
                </Button>
                {attempted ? (
                    <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        onClick={() => onCheck(message)}
                        disabled={busy}
                        aria-label={"Check delivery status"}
                        title={"Check delivery status"}
                    >
                        <Icon name="refresh" className="h-3 w-3" aria-hidden="true" />
                        {"Check status"}
                    </Button>
                ) : (
                    <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        onClick={() => onSend(message)}
                        disabled={busy}
                        aria-label={"Send now with Steering"}
                        title={"Send now with Steering"}
                    >
                        <Icon name="send-plane" className="h-3 w-3" aria-hidden="true" />
                        {"Steer"}
                    </Button>
                )}
                <button
                    type="button"
                    onClick={() => removeFromQueue(target, message.id)}
                    disabled={busy}
                    className="flex items-center justify-center h-6 w-6 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors disabled:pointer-events-none disabled:opacity-50"
                    aria-label={"Remove follow-up"}
                >
                    <Icon name="close" className="h-4 w-4 text-muted-foreground" />
                </button>
            </div>
            {(sending || checking || failed || attempted) && (
                <p
                    className={cn(
                        'typography-micro pl-6',
                        failed && !sending && !checking ? 'text-[var(--status-error)]' : attempted && !sending && !checking ? 'text-[var(--status-warning)]' : 'text-muted-foreground',
                    )}
                    role={failed || attempted ? 'status' : undefined}
                >
                    {sending ? "Sending…" : checking ? "Checking status…" : failed ? "Send failed. Retry with Steer or remove." : "Delivery uncertain. Check status before retrying."}
                </p>
            )}
        </div>
    );
});

QueuedMessageChip.displayName = 'QueuedMessageChip';

interface QueuedMessageChipsProps {
    onEditMessage: (content: string, attachments?: QueuedMessage['attachments']) => void;
    onSendMessage: (messageId: string) => void;
}

const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_SENDING: string[] = [];

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
    const sendingIds = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!queueKey) return EMPTY_SENDING;
                return state.sendingIds[queueKey] ?? EMPTY_SENDING;
            },
            [queueKey]
        )
    );
    const popToInput = useMessageQueueStore((state) => state.popToInput);
    const reorderQueue = useMessageQueueStore((state) => state.reorderQueue);
    const [checkingIds, setCheckingIds] = React.useState<readonly string[]>([]);
    // Truthful SDK queue depths: the local chip is removed on accepted
    // delivery, but the daemon may still hold steering/follow-up work until
    // `session.queue` drains. Subscribe narrowly to this session's topic and
    // read only the stable `queue` leaf — never a transcript scan. The
    // selector returns the collection map without capturing the id and the
    // lookup happens in the hook body: `usePiSessionSnapshot` caches by
    // store snapshot identity, so an id-capturing selector would keep
    // returning the previous session when the store has not emitted. The
    // custom equality compares only this session's queue numbers, so token
    // deltas that replace the map keep the previous reference and skip
    // re-renders.
    const sessionQueueTopic = currentSessionId ? (`session:${currentSessionId}` as const) : ('*' as const);
    const reducerBySession = usePiSessionSnapshot(
        (state) => state.reducer.bySession,
        (a, b) => {
            if (Object.is(a, b)) return true;
            if (!currentSessionId) return true;
            const previous = a.get(currentSessionId)?.queue;
            const next = b.get(currentSessionId)?.queue;
            if (!previous && !next) return true;
            if (!previous || !next) return false;
            return previous.steering === next.steering && previous.followUp === next.followUp;
        },
        sessionQueueTopic,
    );
    const sdkQueue = currentSessionId ? reducerBySession.get(currentSessionId)?.queue : undefined;
    const sdkSteeringWaiting = sdkQueue?.steering ?? 0;
    const sdkFollowUpWaiting = sdkQueue?.followUp ?? 0;
    const hasSdkWaiting = sdkSteeringWaiting > 0 || sdkFollowUpWaiting > 0;
    const hasLocalQueue = Boolean(target) && queuedMessages.length > 0;
    const steeringWaitingText = sdkSteeringWaiting === 1
        ? '1 steering message waiting'
        : `${sdkSteeringWaiting} steering messages waiting`;
    const followUpWaitingText = sdkFollowUpWaiting === 1
        ? '1 follow-up message waiting'
        : `${sdkFollowUpWaiting} follow-up messages waiting`;

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

    const handleCheck = React.useCallback(async (message: QueuedMessage) => {
        if (!target || !queueKey) return;
        if (checkingIds.includes(message.id) || sendingIds.includes(message.id)) return;
        // Read the latest store — never a stale render snapshot — so a send
        // that just completed cannot be re-checked after removal.
        const latest = useMessageQueueStore.getState().queuedMessages[queueKey]?.find((entry) => entry.id === message.id);
        const attempt = latest?.deliveryAttempt ?? message.deliveryAttempt;
        if (!attempt) return;
        setCheckingIds((previous) => previous.includes(message.id) ? previous : [...previous, message.id]);
        try {
            // Read-only receipt query: never sends, never replays. Only an
            // accepted receipt removes the entry; every other state keeps it
            // visible with an explicit unknown warning.
            const status = await queryQueuedSendReceipt(target, attempt);
            if (status === 'accepted') {
                useMessageQueueStore.getState().completeQueuedSend(target, message.id);
            } else if (status === 'pending') {
                toast.info('Delivery still pending. Follow-ups are on hold. Check again later.');
            } else {
                toast.warning('Delivery status unknown. The message stays on hold. No resend attempted.');
            }
        } finally {
            setCheckingIds((previous) => previous.filter((id) => id !== message.id));
        }
    }, [target, queueKey, checkingIds, sendingIds]);

    if (!hasLocalQueue && !hasSdkWaiting) {
        return null;
    }

    return (
        <div className="pb-2 w-full px-1">
            <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
                {hasLocalQueue && target && (
                    <>
                        <div className="flex w-full items-center gap-2 px-3 py-2 text-left">
                            <span className="typography-ui-label font-medium text-foreground flex-shrink-0">
                                {"Follow-up messages"} {queuedMessages.length}
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
                                    {queuedMessages.map((message) => (
                                        <QueuedMessageChip
                                            key={message.id}
                                            message={message}
                                            target={target}
                                            sending={sendingIds.includes(message.id)}
                                            checking={checkingIds.includes(message.id)}
                                            onEdit={handleEdit}
                                            onSend={handleSend}
                                            onCheck={handleCheck}
                                        />
                                    ))}
                                </div>
                            </SortableContext>
                        </DndContext>
                    </>
                )}
                {hasSdkWaiting && (
                    <div className={cn('px-3 typography-micro text-muted-foreground', hasLocalQueue ? 'pb-3 pt-1' : 'py-2')}>
                        {sdkSteeringWaiting > 0 && <p role="status">{steeringWaitingText}</p>}
                        {sdkFollowUpWaiting > 0 && <p role="status">{followUpWaitingText}</p>}
                    </div>
                )}
            </div>
        </div>
    );
});

QueuedMessageChips.displayName = 'QueuedMessageChips';
