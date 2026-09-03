import type { Part } from '@/lib/chat/types';
import { isShellActionPart, isSubtaskPart } from './userAuxiliaryPartsModel';

type PartWithText = Part & { text?: string; content?: string; value?: string };

const isValidPart = (part: unknown): part is Part => {
    return Boolean(part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string');
};

export const normalizeParts = (parts: Part[]): Part[] => {
    return parts.filter(isValidPart);
};

export const extractTextContent = (part: Part): string => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    if (typeof rawText === 'string') {
        return rawText;
    }
    return partWithText.content || partWithText.value || '';
};

const isEmptyTextPart = (part: Part): boolean => {
    if (part.type !== 'text') {
        return false;
    }
    const text = extractTextContent(part);
    return !text || text.trim().length === 0;
};

/**
 * True for parts that render inside the user bubble itself (text, subtasks,
 * shell actions). File parts render in the message footer below the bubble,
 * so ChatMessage uses this to skip the bubble box for attachment-only
 * messages instead of leaving an empty pill.
 */
export const isUserBubbleContentPart = (part: Part): boolean => {
    if (part.type === 'text') {
        return !isEmptyTextPart(part);
    }
    return isSubtaskPart(part) || isShellActionPart(part);
};

export const filterRenderableAssistantParts = (parts: Part[]): Part[] => parts.filter((part) => {
    if (isEmptyTextPart(part)) {
        return false;
    }
    return (part as { type?: unknown }).type !== 'compaction';
});

/**
 * True when an assistant message has anything worth mounting: renderable
 * parts (non-empty text, reasoning, tools, files) or an error notice.
 * An `assistant.message.start` row arrives with no parts and stays empty
 * until the first delta/tool event, so ChatMessage uses this to skip the
 * padded wrapper instead of leaving a blank whitespace block.
 */
export const hasRenderableAssistantContent = (visibleParts: Part[], errorMessage?: string): boolean => {
    if (typeof errorMessage === 'string' && errorMessage.trim().length > 0) {
        return true;
    }
    return filterRenderableAssistantParts(visibleParts).length > 0;
};

type PartWithSynthetic = Part & { synthetic?: boolean };

interface VisibleFilterOptions {
    includeReasoning?: boolean;
}

export const filterVisibleParts = (parts: Part[], options: VisibleFilterOptions = {}): Part[] => {
    const { includeReasoning = true } = options;
    const validParts = normalizeParts(parts);

    // Check if there are any non-synthetic parts
    const hasNonSynthetic = validParts.some((part) => {
        const partWithSynthetic = part as PartWithSynthetic;
        return !partWithSynthetic.synthetic;
    });

    return validParts.filter((part) => {
        const partWithSynthetic = part as PartWithSynthetic;
        const isSynthetic = Boolean(partWithSynthetic.synthetic);

        if (isSynthetic && part.type === 'text') {
            const text = extractTextContent(part);
            if (text.includes('<system-reminder>')) {
                return false;
            }
        }

        // Only filter out synthetic parts if there are non-synthetic parts present
        // Otherwise, show synthetic parts so the message is displayed
        if (isSynthetic && hasNonSynthetic) {
            return false;
        }
        if (!includeReasoning && part.type === 'reasoning') {
            return false;
        }
        const isPatchPart = part.type === 'patch';

        return !isPatchPart;
    });
};
