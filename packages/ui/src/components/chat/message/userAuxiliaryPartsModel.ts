import type { Part } from '@/lib/chat/types';

export type SubtaskPartLike = Part & {
    type: 'subtask';
    description?: unknown;
    command?: unknown;
    agent?: unknown;
    prompt?: unknown;
    taskSessionID?: unknown;
    model?: {
        providerID?: unknown;
        modelID?: unknown;
    };
};

export type ShellActionPartLike = Part & {
    type: 'text';
    shellAction?: {
        command?: unknown;
        output?: unknown;
        status?: unknown;
    };
};

export const isSubtaskPart = (part: Part): part is SubtaskPartLike => part.type === 'subtask';

export const isShellActionPart = (part: Part): part is ShellActionPartLike => {
    const textPart = part as unknown as { type?: unknown; shellAction?: unknown };
    return textPart.type === 'text' && typeof textPart.shellAction === 'object' && textPart.shellAction !== null;
};
