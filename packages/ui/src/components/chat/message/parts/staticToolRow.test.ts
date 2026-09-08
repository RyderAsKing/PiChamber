import { describe, expect, test } from 'bun:test';

import type { ToolPart } from '@/lib/chat/types';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { areStaticToolRowPropsEqual } from './StaticToolRow';

const readPart = (state: ToolPart['state']): ToolPart => ({
    id: 'tool-1',
    type: 'tool',
    tool: 'read',
    state,
});

const readActivity = (part: ToolPart, overrides: Partial<TurnActivityRecord> = {}): TurnActivityRecord => ({
    id: part.id,
    turnId: 'turn-1',
    messageId: 'assistant-1',
    partIndex: 0,
    part,
    kind: 'tool',
    ...overrides,
});

const baseProps = (activity: TurnActivityRecord) => ({
    toolName: 'read',
    activity,
    animateTailText: false,
});

describe('StaticToolRow memo comparator', () => {
    test('treats an equivalent activity (same identity, same part reference) as stable', () => {
        const part = readPart({ status: 'completed', time: { start: 1000, end: 1100 } });
        const activity = readActivity(part);

        expect(areStaticToolRowPropsEqual(baseProps(activity), baseProps({ ...activity }))).toBe(true);
        expect(areStaticToolRowPropsEqual(baseProps(activity), baseProps(readActivity(part)))).toBe(true);
    });

    test('invalidates when the same-ID activity replaces its state metadata', () => {
        const activity = readActivity(readPart({
            status: 'completed',
            time: { start: 1000, end: 1100 },
            input: { path: '/notes/SKILL.md' },
        }));
        const withSkillMetadata = readActivity(readPart({
            status: 'completed',
            time: { start: 1000, end: 1100 },
            input: { path: '/notes/SKILL.md' },
            metadata: { pichamber: { skill: { name: 'code-review' } } },
        }));

        expect(areStaticToolRowPropsEqual(baseProps(activity), baseProps(withSkillMetadata))).toBe(false);
    });

    test('invalidates when the same-ID activity replaces its output content', () => {
        const before = readActivity(readPart({ status: 'running', output: 'a' }));
        const after = readActivity(readPart({ status: 'running', output: 'b' }));

        expect(areStaticToolRowPropsEqual(baseProps(before), baseProps(after))).toBe(false);
    });

    test('invalidates when activity identity fields change', () => {
        const part = readPart({ status: 'completed', time: { start: 1000, end: 1100 } });
        const activity = readActivity(part);

        expect(areStaticToolRowPropsEqual(
            baseProps(activity),
            baseProps(readActivity(part, { endedAt: 9999 })),
        )).toBe(false);
        expect(areStaticToolRowPropsEqual(
            baseProps(activity),
            baseProps(readActivity(part, { messageId: 'assistant-2' })),
        )).toBe(false);
        expect(areStaticToolRowPropsEqual(
            baseProps(activity),
            baseProps(readActivity({ ...part, id: 'tool-2' })),
        )).toBe(false);
    });

    test('invalidates when the toolName prop changes', () => {
        const part = readPart({ status: 'completed' });
        const activity = readActivity(part);

        expect(areStaticToolRowPropsEqual(
            baseProps(activity),
            { ...baseProps(activity), toolName: 'grep' },
        )).toBe(false);
    });

    test('invalidates when the animateTailText prop changes', () => {
        const part = readPart({ status: 'completed' });
        const activity = readActivity(part);

        expect(areStaticToolRowPropsEqual(
            baseProps(activity),
            { ...baseProps(activity), animateTailText: true },
        )).toBe(false);
    });
});
