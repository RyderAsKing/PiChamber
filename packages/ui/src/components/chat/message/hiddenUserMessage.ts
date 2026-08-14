import type { Message, Part } from '@/lib/chat/types';

import { deriveMessageRole } from './messageRole';
import { filterVisibleParts, normalizeParts } from './partUtils';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';

/**
 * A user message is hidden when none of its parts survive display
 * normalization (e.g. synthetic subagent-completion nudges). Turns separated
 * only by such messages should render as one continuous flow.
 */
// Streaming recomputes turn projections often; cache by parts reference so
// unchanged messages resolve without re-running display normalization.
const hiddenByParts = new WeakMap<Part[], boolean>();

export const isHiddenUserMessage = (
    entry: { info: Message; parts: Part[] } | null | undefined
): boolean => {
    if (!entry) return false;
    if (!deriveMessageRole(entry.info).isUser) return false;

    const cached = hiddenByParts.get(entry.parts);
    if (cached !== undefined) {
        return cached;
    }

    const parts = normalizeUserDisplayParts(normalizeParts(entry.parts));
    const hidden = filterVisibleParts(parts, { includeReasoning: true }).length === 0;
    hiddenByParts.set(entry.parts, hidden);
    return hidden;
};
