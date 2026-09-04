import type { TurnActivityRecord } from '../lib/turns/types';

export const INITIAL_VISIBLE_TOOL_COUNT = 40;
export const ACTIVITY_LOAD_BATCH_SIZE = 40;

interface VisibleTurnActivity {
    activities: TurnActivityRecord[];
    hiddenToolCount: number;
}

/**
 * Keep the newest tools mounted while retaining the activity order around them.
 * Older activity is intentionally omitted from the DOM until the user asks for
 * it; this keeps long turns responsive without changing the authoritative log.
 */
export const getVisibleTurnActivity = (
    activities: TurnActivityRecord[],
    visibleToolCount: number,
): VisibleTurnActivity => {
    const toolCount = activities.reduce(
        (count, activity) => count + (activity.kind === 'tool' ? 1 : 0),
        0,
    );
    const boundedToolCount = Math.max(0, visibleToolCount);
    const hiddenToolCount = Math.max(0, toolCount - boundedToolCount);
    if (hiddenToolCount === 0) {
        return { activities, hiddenToolCount: 0 };
    }

    let remainingToHide = hiddenToolCount;
    let firstVisibleIndex = 0;
    for (let index = 0; index < activities.length; index += 1) {
        if (activities[index]?.kind !== 'tool') {
            continue;
        }
        remainingToHide -= 1;
        firstVisibleIndex = index + 1;
        if (remainingToHide === 0) {
            break;
        }
    }

    return {
        activities: activities.slice(firstVisibleIndex),
        hiddenToolCount,
    };
};
