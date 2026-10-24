import type { TurnIndexes, TurnProjectionResult, TurnRecord } from './types';

export const projectTurnIndexes = (turns: TurnRecord[]): TurnProjectionResult => {
    const turnById = new Map<string, TurnRecord>();
    const messageToTurnId = new Map<string, string>();
    const messageMetaById: TurnIndexes['messageMetaById'] = new Map();
    const groupedMessageIds = new Set<string>();

    turns.forEach((turn) => {
        turnById.set(turn.turnId, turn);

        const firstAssistantId = turn.assistantMessages[0]?.info.id;
        const lastAssistantId = turn.assistantMessages[turn.assistantMessages.length - 1]?.info.id;

        messageToTurnId.set(turn.userMessageId, turn.turnId);
        groupedMessageIds.add(turn.userMessageId);
        messageMetaById.set(turn.userMessageId, {
            turnId: turn.turnId,
            messageId: turn.userMessageId,
            userMessageId: turn.userMessageId,
            isUserMessage: true,
            isAssistantMessage: false,
            isFirstAssistantInTurn: false,
            isLastAssistantInTurn: false,
            headerMessageId: turn.headerMessageId,
        });

        turn.assistantMessageIds.forEach((assistantMessageId) => {
            messageToTurnId.set(assistantMessageId, turn.turnId);
            groupedMessageIds.add(assistantMessageId);
            messageMetaById.set(assistantMessageId, {
                turnId: turn.turnId,
                messageId: assistantMessageId,
                userMessageId: turn.userMessageId,
                isUserMessage: false,
                isAssistantMessage: true,
                isFirstAssistantInTurn: assistantMessageId === firstAssistantId,
                isLastAssistantInTurn: assistantMessageId === lastAssistantId,
                headerMessageId: turn.headerMessageId,
            });
        });

        (turn.notices ?? []).forEach((notice) => {
            messageToTurnId.set(notice.info.id, turn.turnId);
            groupedMessageIds.add(notice.info.id);
            messageMetaById.set(notice.info.id, {
                turnId: turn.turnId,
                messageId: notice.info.id,
                userMessageId: turn.userMessageId,
                isUserMessage: false,
                isAssistantMessage: false,
                isFirstAssistantInTurn: false,
                isLastAssistantInTurn: false,
                headerMessageId: turn.headerMessageId,
            });
        });
    });

    const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    const lastTurnMessageIds = new Set<string>();
    if (lastTurn) {
        lastTurnMessageIds.add(lastTurn.userMessageId);
        lastTurn.assistantMessageIds.forEach((messageId) => {
            lastTurnMessageIds.add(messageId);
        });
        (lastTurn.notices ?? []).forEach((notice) => {
            lastTurnMessageIds.add(notice.info.id);
        });
    }

    return {
        turns,
        indexes: {
            turnById,
            messageToTurnId,
            messageMetaById,
        },
        lastTurnId: lastTurn?.turnId ?? null,
        lastTurnMessageIds,
        ungroupedMessageIds: new Set<string>(),
    };
};
