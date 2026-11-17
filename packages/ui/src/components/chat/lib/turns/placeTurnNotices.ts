import type { ChatMessageEntry, TurnActivityRecord } from './types';

/**
 * Time placement for a running turn's live notices (`turn.notices`).
 *
 * A notice renders where it arrived in the turn, so later output pushes it
 * up instead of the notice sitting above everything the turn produced.
 * Placement compares the notice's daemon-clock `createdAt` with the created
 * time of the assistant message that owns each row. Both come from the
 * daemon clock; tool `startedAt` is rebased to the client clock, so it is
 * deliberately not used. Pi starts a new assistant message for each tool
 * round, so this orders notices between tool rounds. Text streamed into a
 * single message carries no per-chunk time, so a notice that arrives while
 * one reply streams sits below that whole reply.
 *
 * Same rule as `applyExtensionNoticeOverlay`: a notice goes before the first
 * row whose message was created at or after it.
 */

const EMPTY_NOTICES: ChatMessageEntry[] = [];

export const getEntryCreatedAt = (entry: ChatMessageEntry): number | undefined => {
    const created = (entry.info as { time?: { created?: unknown } }).time?.created;
    return typeof created === 'number' ? created : undefined;
};

interface NoticeAnchor {
    id: string;
    createdAt: number | undefined;
}

interface NoticeSplit {
    /** Notices to render before the anchor with this id. */
    beforeById: ReadonlyMap<string, ChatMessageEntry[]>;
    /** Notices newer than every anchor, rendered after the last one. */
    trailing: ChatMessageEntry[];
}

const EMPTY_SPLIT: NoticeSplit = { beforeById: new Map(), trailing: EMPTY_NOTICES };

/**
 * Splits notices (in arrival order) across anchors (in display order).
 * Anchors without a created time never take notices.
 */
export const splitNoticesByAnchors = (
    notices: readonly ChatMessageEntry[],
    anchors: readonly NoticeAnchor[],
): NoticeSplit => {
    if (notices.length === 0) return EMPTY_SPLIT;
    const beforeById = new Map<string, ChatMessageEntry[]>();
    let index = 0;
    for (const anchor of anchors) {
        if (index >= notices.length) break;
        if (anchor.createdAt === undefined) continue;
        while (index < notices.length && (getEntryCreatedAt(notices[index]!) ?? Infinity) <= anchor.createdAt) {
            const bucket = beforeById.get(anchor.id);
            if (bucket) {
                bucket.push(notices[index]!);
            } else {
                beforeById.set(anchor.id, [notices[index]!]);
            }
            index += 1;
        }
    }
    return {
        beforeById,
        trailing: index >= notices.length ? EMPTY_NOTICES : notices.slice(index),
    };
};

export const messageCreatedAtById = (messages: readonly ChatMessageEntry[]): Map<string, number> => {
    const byId = new Map<string, number>();
    for (const message of messages) {
        const created = getEntryCreatedAt(message);
        if (created !== undefined) byId.set(message.info.id, created);
    }
    return byId;
};

interface TurnNoticePartition {
    /** Notices rendered inside the open activity rail, among its rows. */
    rail: ChatMessageEntry[];
    /** Notices rendered among the turn's response messages. */
    response: ChatMessageEntry[];
}

/**
 * Decides which notices render inside the activity rail and which render
 * among the response messages.
 *
 * - Rail closed or empty: every notice goes to the response, so none hide.
 * - Rail open: a notice at or before the last tool round joins the rail.
 *   A newer one also stays at the rail's end (no jump when the next tool
 *   round arrives below it) unless the final answer started before it, in
 *   which case it follows that answer.
 */
export const partitionTurnNotices = ({
    notices,
    activityParts,
    assistantMessages,
    railOpen,
    finalAnswerMessageId,
}: {
    notices: ChatMessageEntry[];
    activityParts: readonly TurnActivityRecord[];
    assistantMessages: readonly ChatMessageEntry[];
    railOpen: boolean;
    finalAnswerMessageId: string | undefined;
}): TurnNoticePartition => {
    if (notices.length === 0) return { rail: EMPTY_NOTICES, response: EMPTY_NOTICES };
    if (!railOpen || activityParts.length === 0) return { rail: EMPTY_NOTICES, response: notices };

    const createdById = messageCreatedAtById(assistantMessages);
    let lastActivityAt: number | undefined;
    for (const activity of activityParts) {
        const created = createdById.get(activity.messageId);
        if (created !== undefined && (lastActivityAt === undefined || created > lastActivityAt)) {
            lastActivityAt = created;
        }
    }
    const finalAnswerAt = finalAnswerMessageId ? createdById.get(finalAnswerMessageId) : undefined;

    const rail: ChatMessageEntry[] = [];
    const response: ChatMessageEntry[] = [];
    for (const notice of notices) {
        const created = getEntryCreatedAt(notice);
        const beforeLastRound = created !== undefined && lastActivityAt !== undefined && created <= lastActivityAt;
        const beforeFinalAnswer = finalAnswerAt === undefined || (created !== undefined && created <= finalAnswerAt);
        if (beforeLastRound || beforeFinalAnswer) {
            rail.push(notice);
        } else {
            response.push(notice);
        }
    }
    if (rail.length === 0) return { rail: EMPTY_NOTICES, response: notices };
    if (response.length === 0) return { rail: notices, response: EMPTY_NOTICES };
    return { rail, response };
};
