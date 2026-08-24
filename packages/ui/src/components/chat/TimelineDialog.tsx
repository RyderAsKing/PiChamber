import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { Icon } from "@/components/icon/Icon";
import { getFullText, getMessagePreview } from './lib/messagePreview';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { toast } from '@/components/ui';
import type { PiSessionTreeNode } from '@/lib/pi/protocol';

interface TimelineDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onScrollToMessage?: (messageId: string) => void | Promise<boolean>;
    onScrollByTurnOffset?: (offset: number) => void;
    onResumeToLatest?: () => void;
    canLoadEarlier?: boolean;
    isLoadingEarlier?: boolean;
    onLoadEarlier?: () => void;
    onRevert?: (messageId: string) => Promise<void> | void;
    onFork?: (messageId: string) => Promise<void> | void;
}

const TimelineDialogContent: React.FC<TimelineDialogProps> = ({
    open,
    onOpenChange,
    onScrollToMessage,
    onScrollByTurnOffset,
    onResumeToLatest,
    canLoadEarlier = false,
    isLoadingEarlier = false,
    onLoadEarlier,
    onRevert,
    onFork,
}) => {
    const { isMobile } = useDeviceInfo();
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const [sessionTreeRevision, setSessionTreeRevision] = React.useState(0);
    React.useEffect(() => {
        if (!currentSessionId) {
            setSessionTreeRevision(0);
            return;
        }
        const update = () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getPiSessionStore } = require('@/apps/pi-session-store');
                setSessionTreeRevision(getPiSessionStore().getState().reducer.bySession.get(currentSessionId)?.sessionTreeRevision ?? 0);
            } catch {
                setSessionTreeRevision(0);
            }
        };
        update();
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getPiSessionStore } = require('@/apps/pi-session-store');
            return getPiSessionStore().subscribe(update, `session:${currentSessionId}`);
        } catch {
            return;
        }
    }, [currentSessionId]);
    const [labelsByEntryId, setLabelsByEntryId] = React.useState<Map<string, string>>(new Map());
    const labelsSessionRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!open || !currentSessionId) return;
        if (labelsSessionRef.current !== currentSessionId) {
            labelsSessionRef.current = currentSessionId;
            setLabelsByEntryId(new Map());
        }
        let cancelled = false;
        void (async () => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getPiSessionStore } = require('@/apps/pi-session-store');
                const tree = await getPiSessionStore().tree(currentSessionId);
                if (cancelled) return;
                const labels = new Map<string, string>();
                const visit = (node: PiSessionTreeNode) => {
                    if (node.label) labels.set(node.entryId, node.label);
                    for (const child of node.children) visit(child);
                };
                for (const node of tree.nodes) visit(node);
                setLabelsByEntryId(labels);
            } catch {
                // A failed refresh is not authoritative empty state. Keep the
                // labels from the last successful tree response.
            }
        })();
        return () => { cancelled = true; };
    }, [currentSessionId, open, sessionTreeRevision]);
    const [isStreaming, setIsStreaming] = React.useState(false);
    React.useEffect(() => {
        if (!currentSessionId) {
            setIsStreaming(false);
            return;
        }
        const update = () => {
            // PiSessionStore is the source for streaming, not the legacy sync store.
            // Dynamically import to avoid cycle in some test setups.
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getPiSessionStore } = require('@/apps/pi-session-store');
                const rec = getPiSessionStore().getState().reducer.bySession.get(currentSessionId);
                setIsStreaming(rec?.lifecycle === 'busy' || rec?.lifecycle === 'retry');
            } catch {
                setIsStreaming(false);
            }
        };
        update();
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getPiSessionStore } = require('@/apps/pi-session-store');
            return getPiSessionStore().subscribe(update, `session:${currentSessionId}`);
        } catch {
            return;
        }
    }, [currentSessionId]);
    const messages = useSessionMessageRecords(currentSessionId ?? '');
    const [searchQuery, setSearchQuery] = React.useState('');
    const [selectedIndex, setSelectedIndex] = React.useState(0);
    const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
    const listRef = React.useRef<HTMLDivElement | null>(null);
    const pendingLoadAnchorRef = React.useRef<{ messageId: string; top: number } | null>(null);
    const preservingLoadPositionRef = React.useRef(false);
    const wasOpenRef = React.useRef(open);

    const formatDateGroup = React.useCallback((timestamp: number): string => {
        return new Date(timestamp).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }, []);

    const formatMessageTime = React.useCallback((timestamp: number): string => {
        return new Date(timestamp).toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
        });
    }, []);

    // Timeline actions are only valid for user messages.
    const userMessages = React.useMemo(() => {
        return messages
            .filter((message) => message.info.role === 'user')
            .map((message) => ({ message }));
    }, [messages]);

    // Filter by search query using all text parts in each user message.
    const filteredMessages = React.useMemo(() => {
        const trimmedQuery = searchQuery.trim();
        if (!trimmedQuery) return userMessages;

        const query = trimmedQuery.toLowerCase();
        return userMessages.filter(({ message }) => {
            const fullText = getFullText(message.parts).toLowerCase();
            return fullText.includes(query);
        });
    }, [userMessages, searchQuery]);

    React.useEffect(() => {
        if (preservingLoadPositionRef.current) {
            return;
        }

        setSelectedIndex(searchQuery.trim() ? 0 : Math.max(0, filteredMessages.length - 1));
    }, [filteredMessages, searchQuery]);

    React.useEffect(() => {
        itemRefs.current = itemRefs.current.slice(0, filteredMessages.length);
    }, [filteredMessages.length]);

    React.useEffect(() => {
        if (preservingLoadPositionRef.current) {
            return;
        }

        itemRefs.current[selectedIndex]?.scrollIntoView({
            block: 'nearest',
        });
    }, [selectedIndex]);

    React.useEffect(() => {
        if (!preservingLoadPositionRef.current || pendingLoadAnchorRef.current || isLoadingEarlier) {
            return;
        }

        preservingLoadPositionRef.current = false;
    }, [filteredMessages.length, isLoadingEarlier]);

    React.useLayoutEffect(() => {
        const wasOpen = wasOpenRef.current;
        wasOpenRef.current = open;

        if (!open || wasOpen || preservingLoadPositionRef.current || searchQuery.trim()) {
            return;
        }

        const container = listRef.current;
        if (!container) {
            return;
        }

        container.scrollTop = container.scrollHeight;
    }, [open, searchQuery]);

    React.useLayoutEffect(() => {
        const anchor = pendingLoadAnchorRef.current;
        const container = listRef.current;
        if (!anchor || !container || isLoadingEarlier) {
            return;
        }

        pendingLoadAnchorRef.current = null;
        const anchoredRow = itemRefs.current.find((row) => row?.dataset.timelineMessageId === anchor.messageId);
        if (!anchoredRow) {
            return;
        }

        const nextTop = anchoredRow.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += nextTop - anchor.top;
    }, [filteredMessages.length, isLoadingEarlier]);

    const handleLoadEarlier = React.useCallback(() => {
        const container = listRef.current;
        if (container) {
            const containerTop = container.getBoundingClientRect().top;
            const firstVisibleRow = itemRefs.current.find((row) => {
                if (!row) return false;
                return row.getBoundingClientRect().bottom >= containerTop;
            });

            if (firstVisibleRow?.dataset.timelineMessageId) {
                pendingLoadAnchorRef.current = {
                    messageId: firstVisibleRow.dataset.timelineMessageId,
                    top: firstVisibleRow.getBoundingClientRect().top - containerTop,
                };
            }
        }

        preservingLoadPositionRef.current = true;
        onLoadEarlier?.();
    }, [onLoadEarlier]);

    const navigateToMessage = React.useCallback(async (messageId: string) => {
        const didNavigate = await onScrollToMessage?.(messageId);
        if (didNavigate === false) {
            return;
        }
        onOpenChange(false);
    }, [onOpenChange, onScrollToMessage]);

    const handleSearchKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        const total = filteredMessages.length;
        if (total === 0) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((current) => (current + 1) % total);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex((current) => (current - 1 + total) % total);
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            const safeIndex = ((selectedIndex % total) + total) % total;
            const selected = filteredMessages[safeIndex];
            if (selected) {
                void navigateToMessage(selected.message.info.id);
            }
        }
    }, [filteredMessages, navigateToMessage, selectedIndex]);

    const handleRevertSelected = React.useCallback(async () => {
        const total = filteredMessages.length;
        if (total === 0 || !onRevert || isStreaming) return;
        const safeIndex = ((selectedIndex % total) + total) % total;
        const selected = filteredMessages[safeIndex];
        if (!selected) return;
        try {
            await onRevert(selected.message.info.id);
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to revert');
        }
    }, [filteredMessages, isStreaming, onRevert, onOpenChange, selectedIndex]);

    const handleForkSelected = React.useCallback(async () => {
        const total = filteredMessages.length;
        if (total === 0 || !onFork || isStreaming) return;
        const safeIndex = ((selectedIndex % total) + total) % total;
        const selected = filteredMessages[safeIndex];
        if (!selected) return;
        try {
            await onFork(selected.message.info.id);
            onOpenChange(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to fork');
        }
    }, [filteredMessages, isStreaming, onFork, onOpenChange, selectedIndex]);

    const handleListKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const total = filteredMessages.length;
        if (total === 0) return;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((current) => (current + 1) % total);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex((current) => (current - 1 + total) % total);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const safeIndex = ((selectedIndex % total) + total) % total;
            const selected = filteredMessages[safeIndex];
            if (selected) void navigateToMessage(selected.message.info.id);
        }
    }, [filteredMessages, navigateToMessage, selectedIndex]);

    void onScrollByTurnOffset;
    void onResumeToLatest;
    // Auto-focus the list when dialog opens so arrow keys work immediately (desktop).
    // On mobile, the search input autoFocus takes precedence.
    React.useEffect(() => {
        if (!open || isMobile) return;
        // Focus the list container after the dialog animation.
        const timer = window.setTimeout(() => listRef.current?.focus(), 100);
        return () => window.clearTimeout(timer);
    }, [open, isMobile]);

    if (!currentSessionId) return null;

    const selectedMessage = filteredMessages[((selectedIndex % Math.max(1, filteredMessages.length)) + Math.max(1, filteredMessages.length)) % Math.max(1, filteredMessages.length)]?.message ?? null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={cn("flex flex-col", isMobile ? "max-w-full max-h-[85vh] rounded-t-2xl mt-auto" : "max-w-2xl max-h-[70vh]")}>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Icon name="time" className="h-5 w-5" />
                        {"Conversation Timeline"}
                    </DialogTitle>
                    <DialogDescription>
                        {isMobile ? "Tap a message, then Revert or Fork" : "Arrow keys to move • Enter to jump"}
                    </DialogDescription>
                </DialogHeader>

                {!isMobile && (
                    <div className="relative mt-2">
                        <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            placeholder={"Search messages..."}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={handleSearchKeyDown}
                            className="pl-9 w-full"
                        />
                    </div>
                )}

                {canLoadEarlier && onLoadEarlier && (
                    <div className="flex justify-center py-1">
                        <Button
                            type="button"
                            variant="link"
                            size="sm"
                            onClick={handleLoadEarlier}
                            disabled={isLoadingEarlier}
                            className="h-auto px-1 py-0 text-muted-foreground hover:text-foreground"
                        >
                            {isLoadingEarlier && (
                                <Icon name="loader-4" className="size-4 animate-spin" />
                            )}
                            {"Load older messages"}
                        </Button>
                    </div>
                )}

                <div ref={listRef} tabIndex={0} onKeyDown={handleListKeyDown} className="flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-ring rounded" aria-label="Message list">
                    {filteredMessages.length === 0 ? (
                        <div className="text-center text-muted-foreground py-8">
                            {searchQuery ? "No messages found" : "No messages in this session yet"}
                        </div>
                    ) : (
                        filteredMessages.map(({ message }, index) => {
                            const preview = getMessagePreview(message.parts);
                            const timestamp = message.info.time?.created ?? 0;
                            const dateGroup = formatDateGroup(timestamp);
                            const previous = filteredMessages[index - 1];
                            const previousDateGroup = previous
                                ? formatDateGroup(previous.message.info.time?.created ?? 0)
                                : null;
                            const showDateGroup = dateGroup !== previousDateGroup;
                            const messageTime = formatMessageTime(timestamp);
                            const isSelected = index === selectedIndex;
                            const label = labelsByEntryId.get(message.info.id);

                            const snippet = searchQuery.trim()
                                ? getSearchSnippet(getFullText(message.parts), searchQuery)
                                : null;

                            return (
                                <React.Fragment key={message.info.id}>
                                    {showDateGroup && (
                                        <div className="sticky top-0 z-10 flex items-center gap-3 bg-background/95 py-2 backdrop-blur-sm">
                                            <div className="h-px flex-1 bg-border/60" />
                                            <span className="typography-meta text-muted-foreground">
                                                {dateGroup}
                                            </span>
                                            <div className="h-px flex-1 bg-border/60" />
                                        </div>
                                    )}
                                    <div
                                        ref={(element) => {
                                            itemRefs.current[index] = element;
                                        }}
                                        data-timeline-message-id={message.info.id}
                                        className={cn(
                                            "group flex items-center gap-3 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer",
                                            isSelected && "bg-interactive-selection text-interactive-selection-foreground"
                                        )}
                                        onClick={() => void navigateToMessage(message.info.id)}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                    >
                                        <span className={cn(
                                            "typography-meta w-16 flex-shrink-0 text-right tabular-nums",
                                            isSelected ? "text-interactive-selection-foreground/70" : "text-muted-foreground"
                                        )}>
                                            {messageTime}
                                        </span>
                                        {label && (
                                            <span className="max-w-40 shrink-0 truncate rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 typography-micro text-muted-foreground">
                                                {label}
                                            </span>
                                        )}
                                        <p className={cn(
                                            "flex-1 min-w-0 typography-small truncate",
                                            isSelected ? "text-interactive-selection-foreground" : "text-foreground"
                                        )}>
                                            {snippet ?? (preview || "[No text content]")}
                                            {!snippet && preview && preview.length >= 80 && '…'}
                                        </p>

                                    </div>
                                </React.Fragment>
                            );
                        })
                    )}
                </div>

                {selectedMessage && (
                    <div className={cn("flex gap-2 mt-3", isMobile ? "flex-col" : "flex-row")}> 
                        <Button
                            type="button"
                            variant={isMobile ? "default" : "outline"}
                            size={isMobile ? "default" : "sm"}
                            className={cn(isMobile && "w-full justify-center h-11 text-base")}
                            disabled={isStreaming}
                            onClick={() => void handleRevertSelected()}
                        >
                            <Icon name="history" className="h-4 w-4" />
                            Revert
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size={isMobile ? "default" : "sm"}
                            className={cn(isMobile && "w-full justify-center h-11 text-base")}
                            disabled={isStreaming}
                            onClick={() => void handleForkSelected()}
                        >
                            <Icon name="git-branch" className="h-4 w-4" />
                            Fork
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
};

export const TimelineDialog: React.FC<TimelineDialogProps> = (props) => {
    if (!props.open) {
        return null;
    }
    return <TimelineDialogContent {...props} />;
};

function getSearchSnippet(text: string, query: string, contextChars: number = 30): string | null {
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);
    if (matchIndex === -1) return null;

    const start = Math.max(0, matchIndex - contextChars);
    const end = Math.min(text.length, matchIndex + query.length + contextChars);
    return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\n/g, ' ')}${end < text.length ? '…' : ''}`;
}
