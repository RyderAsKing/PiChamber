import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@/lib/chat/types';

import { EXTENSION_NOTICE_CUSTOM_TYPE } from './applyExtensionNoticeOverlay';
import { partitionTurnNotices, splitNoticesByAnchors } from './placeTurnNotices';
import type { ChatMessageEntry, TurnActivityRecord } from './types';

const assistant = (id: string, created: number): ChatMessageEntry => ({
    info: { id, role: 'assistant', sessionID: 's1', time: { created } } as unknown as Message,
    parts: [] as Part[],
});

const notice = (id: string, created: number): ChatMessageEntry => ({
    info: {
        id: `notice:${id}`,
        role: 'extension',
        sessionID: 's1',
        customType: EXTENSION_NOTICE_CUSTOM_TYPE,
        text: id,
        noticeLevel: 'info',
        time: { created, completed: created },
    } as unknown as Message,
    parts: [] as Part[],
});

const activity = (id: string, messageId: string): TurnActivityRecord => ({
    id,
    turnId: 't1',
    messageId,
    kind: 'tool',
    part: { id, type: 'tool' } as Part,
    partIndex: 0,
});

const ids = (entries: readonly ChatMessageEntry[]) => entries.map((entry) => entry.info.id);

describe('splitNoticesByAnchors', () => {
    test('a notice goes before the first anchor created at or after it', () => {
        const split = splitNoticesByAnchors(
            [notice('n1', 150), notice('n2', 200), notice('n3', 250), notice('n4', 400)],
            [{ id: 'a', createdAt: 100 }, { id: 'b', createdAt: 200 }, { id: 'c', createdAt: 300 }],
        );
        expect(split.beforeById.get('a')).toBeUndefined();
        expect(ids(split.beforeById.get('b')!)).toEqual(['notice:n1', 'notice:n2']);
        expect(ids(split.beforeById.get('c')!)).toEqual(['notice:n3']);
        expect(ids(split.trailing)).toEqual(['notice:n4']);
    });

    test('anchors without a created time take no notices', () => {
        const split = splitNoticesByAnchors(
            [notice('n1', 50)],
            [{ id: 'a', createdAt: undefined }, { id: 'b', createdAt: 100 }],
        );
        expect(split.beforeById.get('a')).toBeUndefined();
        expect(ids(split.beforeById.get('b')!)).toEqual(['notice:n1']);
    });

    test('with no anchors every notice trails', () => {
        expect(ids(splitNoticesByAnchors([notice('n1', 50)], []).trailing)).toEqual(['notice:n1']);
    });
});

describe('partitionTurnNotices', () => {
    const messages = [assistant('a1', 100), assistant('a2', 200), assistant('a3', 300)];
    const activities = [activity('t1', 'a1'), activity('t2', 'a2')];

    test('a closed rail hands every notice to the response', () => {
        const notices = [notice('n1', 150)];
        const result = partitionTurnNotices({
            notices,
            activityParts: activities,
            assistantMessages: messages,
            railOpen: false,
            finalAnswerMessageId: undefined,
        });
        expect(result.rail).toEqual([]);
        expect(result.response).toBe(notices);
    });

    test('an open rail keeps notices up to the last tool round and newer ones before any final answer', () => {
        const notices = [notice('n1', 150), notice('n2', 250)];
        const result = partitionTurnNotices({
            notices,
            activityParts: activities,
            assistantMessages: messages,
            railOpen: true,
            finalAnswerMessageId: undefined,
        });
        expect(result.rail).toBe(notices);
        expect(result.response).toEqual([]);
    });

    test('a notice newer than a started final answer follows it in the response', () => {
        const result = partitionTurnNotices({
            notices: [notice('n1', 150), notice('n2', 250), notice('n3', 350)],
            activityParts: activities,
            assistantMessages: messages,
            railOpen: true,
            finalAnswerMessageId: 'a3',
        });
        expect(ids(result.rail)).toEqual(['notice:n1', 'notice:n2']);
        expect(ids(result.response)).toEqual(['notice:n3']);
    });
});
