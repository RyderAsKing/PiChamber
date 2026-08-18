import type { Part } from '@/lib/chat/types';

import { getNormalizedMessageForDisplay } from '../messageDisplayNormalization';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry, TurnRecord } from './types';

export type StreamingTailEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean };

type BuildLiveStreamingEntryOptions = {
    activeStreamingMessageId: string | null | undefined;
    liveParts: Part[];
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
    mergeHiddenUserTurns?: boolean;
};

const withLiveParts = (
    message: ChatMessageEntry,
    activeStreamingMessageId: string,
    liveParts: Part[],
): ChatMessageEntry => {
    if (message.info.id !== activeStreamingMessageId || message.parts === liveParts) {
        return message;
    }

    return getNormalizedMessageForDisplay({
        ...message,
        parts: liveParts,
    });
};

const isTextOnlyLivePartsChange = (left: readonly Part[], right: readonly Part[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        const previous = left[index];
        const next = right[index];
        if (!previous || !next) return false;
        if (previous.id !== next.id || previous.type !== next.type) return false;
        // Tools/activity membership can change without a new part id. Only text
        // may be a new object; everything else must keep reducer identity.
        if (previous.type !== 'text' && previous !== next) return false;
    }
    return true;
};

const patchTurnMessages = (
    turn: TurnRecord,
    assistantMessages: ChatMessageEntry[],
): TurnRecord['messages'] => {
    if (turn.messages.length === 0) return turn.messages;
    const liveMessageById = new Map(assistantMessages.map((message) => [message.info.id, message]));
    let changed = false;
    const next = turn.messages.map((record) => {
        const live = liveMessageById.get(record.messageId);
        if (!live || live === record.message) return record;
        changed = true;
        return { ...record, message: live };
    });
    return changed ? next : turn.messages;
};

export const buildLiveStreamingEntry = <TEntry extends StreamingTailEntry>(
    entry: TEntry,
    options: BuildLiveStreamingEntryOptions,
): TEntry => {
    const activeStreamingMessageId = options.activeStreamingMessageId;
    if (!activeStreamingMessageId) {
        return entry;
    }

    if (entry.kind === 'ungrouped') {
        const message = withLiveParts(entry.message, activeStreamingMessageId, options.liveParts);
        if (message === entry.message) {
            return entry;
        }
        return {
            ...entry,
            message,
        };
    }

    let changed = false;
    const assistantMessages = entry.turn.assistantMessages.map((message) => {
        const next = withLiveParts(message, activeStreamingMessageId, options.liveParts);
        if (next !== message) {
            changed = true;
        }
        return next;
    });

    if (!changed) {
        return entry;
    }

    const previousAssistant = entry.turn.assistantMessages.find(
        (message) => message.info.id === activeStreamingMessageId,
    );
    const nextAssistant = assistantMessages.find(
        (message) => message.info.id === activeStreamingMessageId,
    );
    const textOnly = Boolean(
        previousAssistant
        && nextAssistant
        && isTextOnlyLivePartsChange(previousAssistant.parts, nextAssistant.parts),
    );

    if (textOnly) {
        return {
            ...entry,
            turn: {
                ...entry.turn,
                assistantMessages,
                messages: patchTurnMessages(entry.turn, assistantMessages),
            },
        };
    }

    // Tool/reasoning membership changed: re-project so activity rows stay in sync.
    const liveMessageById = new Map(assistantMessages.map((message) => [message.info.id, message]));
    const sourceMessages = entry.turn.messages.length > 0
        ? entry.turn.messages
            .slice()
            .sort((left, right) => left.order - right.order)
            .map((record) => liveMessageById.get(record.messageId) ?? record.message)
        : [entry.turn.userMessage, ...assistantMessages];

    const projection = projectTurnRecords(sourceMessages, {
        showTextJustificationActivity: options.showTextJustificationActivity,
        showTurnChangedFiles: options.showTurnChangedFiles,
        mergeHiddenUserTurns: options.mergeHiddenUserTurns,
    });
    const turn = projection.turns[0] ?? {
        ...entry.turn,
        assistantMessages,
        assistantMessageIds: assistantMessages.map((message) => message.info.id),
        messages: patchTurnMessages(entry.turn, assistantMessages),
    };

    return {
        ...entry,
        turn,
    };
};
