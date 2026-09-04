import { describe, expect, test } from 'bun:test';

import { resolveTurnActivityDisclosure } from './turnActivityDisclosure';

describe('resolveTurnActivityDisclosure', () => {
    test('collapses when final output starts even after a manual disclosure change', () => {
        expect(resolveTurnActivityDisclosure({
            isExpanded: true,
            userToggled: true,
            wasAutoCollapsed: false,
            hasActivity: true,
            showWorkingStatus: true,
            hasFinalText: true,
            previousHadFinalText: false,
            hasNewActivity: false,
        })).toEqual({
            isExpanded: false,
            wasAutoCollapsed: true,
            resetUserToggle: true,
        });
    });

    test('reopens for later activity after an automatic final-output collapse', () => {
        expect(resolveTurnActivityDisclosure({
            isExpanded: false,
            userToggled: false,
            wasAutoCollapsed: true,
            hasActivity: true,
            showWorkingStatus: true,
            hasFinalText: false,
            previousHadFinalText: true,
            hasNewActivity: true,
        })).toEqual({
            isExpanded: true,
            wasAutoCollapsed: false,
            resetUserToggle: false,
        });
    });

    test('preserves a manual reopen after final output has already started', () => {
        expect(resolveTurnActivityDisclosure({
            isExpanded: true,
            userToggled: true,
            wasAutoCollapsed: true,
            hasActivity: true,
            showWorkingStatus: true,
            hasFinalText: true,
            previousHadFinalText: true,
            hasNewActivity: false,
        }).isExpanded).toBe(true);
    });
});
