import { describe, expect, test } from 'bun:test';

import type { TurnActivityRecord } from '../lib/turns/types';
import {
    getVisibleTurnActivity,
    INITIAL_VISIBLE_TOOL_COUNT,
} from './turnActivityModel';

const makeTool = (index: number): TurnActivityRecord => ({
    id: `tool-${index}`,
    turnId: 'turn-1',
    messageId: `message-${index}`,
    partIndex: 0,
    part: {
        id: `tool-${index}`,
        type: 'tool',
        tool: 'bash',
    },
    kind: 'tool',
});

describe('turn activity projection', () => {
    test('keeps the newest forty tools and their surrounding order', () => {
        const activities = [
            { ...makeTool(0), kind: 'tool' as const },
            {
                id: 'reasoning-0',
                turnId: 'turn-1',
                messageId: 'message-0',
                partIndex: 1,
                part: { id: 'reasoning-0', type: 'reasoning', text: 'recent thought' },
                kind: 'reasoning' as const,
            },
            ...Array.from({ length: 44 }, (_, index) => makeTool(index + 1)),
        ];

        const visible = getVisibleTurnActivity(activities, INITIAL_VISIBLE_TOOL_COUNT);

        expect(visible.hiddenToolCount).toBe(5);
        expect(visible.activities.find((activity) => activity.kind === 'tool')?.id).toBe('tool-5');
        expect(visible.activities.filter((activity) => activity.kind === 'tool')).toHaveLength(40);
        expect(visible.activities[0]?.id).toBe('tool-5');
    });

    test('does not slice short activity lists', () => {
        const activities = [makeTool(1)];
        const visible = getVisibleTurnActivity(activities, INITIAL_VISIBLE_TOOL_COUNT);

        expect(visible.hiddenToolCount).toBe(0);
        expect(visible.activities).toBe(activities);
    });
});
