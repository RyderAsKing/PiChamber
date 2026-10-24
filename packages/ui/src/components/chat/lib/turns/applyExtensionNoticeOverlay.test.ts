import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '@/lib/chat/types';
import type { PiExtensionNotice } from '@/lib/pi/reducers/reducerTypes';

import { applyExtensionNoticeOverlay, EXTENSION_NOTICE_CUSTOM_TYPE } from './applyExtensionNoticeOverlay';
import type { ChatMessageEntry } from './types';

const message = (id: string, created: number, role = 'user'): ChatMessageEntry => ({
    info: { id, role, sessionID: 's1', time: { created, completed: created } } as unknown as Message,
    parts: [] as Part[],
});

const notice = (
    id: string,
    createdAt: number,
    level: PiExtensionNotice['level'] = 'info',
): PiExtensionNotice => ({ id, message: `body-${id}`, level, createdAt });

const noticeIds = (entries: ChatMessageEntry[]): string[] => entries
    .filter((entry) => (entry.info as { customType?: unknown }).customType === EXTENSION_NOTICE_CUSTOM_TYPE)
    .map((entry) => entry.info.id);

const ids = (entries: ChatMessageEntry[]): string[] => entries.map((entry) => entry.info.id);

describe('applyExtensionNoticeOverlay', () => {
    test('returns the same array reference when there are no notices', () => {
        const messages = [message('u1', 100), message('a1', 200)];
        expect(applyExtensionNoticeOverlay(messages, [], 's1')).toBe(messages);
    });

    test('returns the same array reference without a session id', () => {
        const messages = [message('u1', 100)];
        expect(applyExtensionNoticeOverlay(messages, [notice('n1', 150)], null)).toBe(messages);
    });

    test('notices newer than everything append at the end', () => {
        const messages = [message('u1', 100), message('a1', 200)];
        const result = applyExtensionNoticeOverlay(messages, [notice('n1', 300)], 's1');
        expect(ids(result)).toEqual(['u1', 'a1', 'notice:n1']);
        // Untouched messages keep their references.
        expect(result[0]).toBe(messages[0]);
        expect(result[1]).toBe(messages[1]);
    });

    test('notices insert after the last message at or before their created time', () => {
        const messages = [message('u1', 100), message('u2', 300), message('a2', 400)];
        const result = applyExtensionNoticeOverlay(
            messages,
            [notice('n1', 200), notice('n2', 350)],
            's1',
        );
        expect(ids(result)).toEqual(['u1', 'notice:n1', 'u2', 'notice:n2', 'a2']);
    });

    test('a notice older than every message inserts at the front', () => {
        const messages = [message('u1', 100)];
        const result = applyExtensionNoticeOverlay(messages, [notice('n1', 50)], 's1');
        expect(ids(result)).toEqual(['notice:n1', 'u1']);
    });

    test('notices sort by daemon clock, keeping arrival order for ties', () => {
        const messages = [message('u1', 100)];
        const result = applyExtensionNoticeOverlay(
            messages,
            [notice('late', 300), notice('early', 50), notice('tie-a', 150, 'warning'), notice('tie-b', 150, 'warning')],
            's1',
        );
        expect(noticeIds(result)).toEqual(['notice:early', 'notice:tie-a', 'notice:tie-b', 'notice:late']);
    });

    test('adjacent info notices are all kept (no coalescing)', () => {
        const messages = [message('u1', 100)];
        const result = applyExtensionNoticeOverlay(
            messages,
            [notice('n1', 150), notice('n2', 160)],
            's1',
        );
        expect(noticeIds(result)).toEqual(['notice:n1', 'notice:n2']);
    });

    test('info notices separated by a message are both kept', () => {
        const messages = [message('u1', 100), message('u2', 200)];
        const result = applyExtensionNoticeOverlay(
            messages,
            [notice('n1', 150), notice('n2', 250)],
            's1',
        );
        expect(noticeIds(result)).toEqual(['notice:n1', 'notice:n2']);
    });

    test('warnings, errors, and adjacent info notices are all kept in order', () => {
        const messages = [message('u1', 100)];
        const result = applyExtensionNoticeOverlay(
            messages,
            [
                notice('i1', 150),
                notice('w1', 151, 'warning'),
                notice('i2', 152),
                notice('e1', 153, 'error'),
                notice('e2', 154, 'error'),
            ],
            's1',
        );
        expect(noticeIds(result)).toEqual(['notice:i1', 'notice:w1', 'notice:i2', 'notice:e1', 'notice:e2']);
    });

    test('notice entries carry the notice identity, level, and clock', () => {
        const result = applyExtensionNoticeOverlay([], [notice('n1', 150, 'warning')], 's1');
        expect(result).toHaveLength(1);
        const info = result[0]!.info as unknown as Record<string, unknown>;
        expect(info.role).toBe('extension');
        expect(info.customType).toBe(EXTENSION_NOTICE_CUSTOM_TYPE);
        expect(info.text).toBe('body-n1');
        expect(info.noticeLevel).toBe('warning');
        expect(info.sessionID).toBe('s1');
        expect(info.time).toEqual({ created: 150, completed: 150 });
        expect(result[0]!.parts).toEqual([]);
    });

    test('identical inputs produce deeply equal output', () => {
        const messages = [message('u1', 100), message('a1', 200)];
        const notices = [notice('n1', 150), notice('n2', 250, 'error')];
        const first = applyExtensionNoticeOverlay(messages, notices, 's1');
        const second = applyExtensionNoticeOverlay(messages, notices, 's1');
        expect(second).toEqual(first);
        expect(second).not.toBe(first);
    });

    test('reuses the projected entry for an unchanged notice across re-runs', () => {
        const notices = [notice('n1', 150)];
        const first = applyExtensionNoticeOverlay([message('u1', 100)], notices, 's1');
        // A streaming update re-runs the overlay with new message records.
        const second = applyExtensionNoticeOverlay([message('u1', 100), message('a1', 200)], notices, 's1');
        const firstNotice = first.find((entry) => entry.info.id === 'notice:n1');
        const secondNotice = second.find((entry) => entry.info.id === 'notice:n1');
        expect(firstNotice).toBeDefined();
        expect(secondNotice).toBe(firstNotice);
    });
});
