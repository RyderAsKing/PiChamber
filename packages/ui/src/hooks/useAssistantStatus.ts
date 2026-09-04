import React from 'react';
import type { Message, Part, TextPart, ToolPart } from '@/lib/chat/types';
import type { PiReducerMessagePart } from '@/lib/pi/event-reducer';

import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessages, useSessionPermissions, useSessionQuestions, useSessionStatus } from '@/sync/sync-context';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { selectStreamingAssistantMessageId } from '@/sync/suspend-live-tail-records';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { useCurrentSessionActivity } from './useSessionActivity';

type AssistantActivity = 'idle' | 'streaming' | 'tooling' | 'cooldown' | 'permission';

interface WorkingSummary {
    activity: AssistantActivity;
    hasWorkingContext: boolean;
    hasActiveTools: boolean;
    isWorking: boolean;
    isStreaming: boolean;
    isCooldown: boolean;
    lifecyclePhase: MessageStreamPhase | null;
    statusText: string | null;
    isGenericStatus: boolean;
    isWaitingForPermission: boolean;
    canAbort: boolean;
    compactionDeadline: number | null;
    activePartType?: 'text' | 'tool' | 'reasoning' | 'editing';
    activeToolName?: string;
    wasAborted: boolean;
    abortActive: boolean;
    lastCompletionId: string | null;
    isComplete: boolean;
    retryInfo: { attempt?: number; next?: number } | null;
}

interface FormingSummary {
    isActive: boolean;
    characterCount: number;
}

export interface AssistantStatusSnapshot {
    activeModel: ActiveAssistantModel | null;
    forming: FormingSummary;
    working: WorkingSummary;
}

interface ActiveAssistantModel {
    providerId: string;
    modelId: string;
}

interface ActiveAssistantContext {
    assistantId: string | null;
    model: ActiveAssistantModel | null;
}

const DEFAULT_WORKING: WorkingSummary = {
    activity: 'idle',
    hasWorkingContext: false,
    hasActiveTools: false,
    isWorking: false,
    isStreaming: false,
    isCooldown: false,
    lifecyclePhase: null,
    statusText: null,
    isGenericStatus: true,
    isWaitingForPermission: false,
    canAbort: false,
    compactionDeadline: null,
    activePartType: undefined,
    activeToolName: undefined,
    wasAborted: false,
    abortActive: false,
    lastCompletionId: null,
    isComplete: false,
    retryInfo: null,
};

const EMPTY_PI_PARTS = new Map<string, PiReducerMessagePart>();
const STATUS_SIGNATURE_SEPARATOR = '\u0000';
const EDITING_TOOLS = new Set([
    'apply_patch',
    'create',
    'edit',
    'file_write',
    'multiedit',
    'str_replace',
    'str_replace_based_edit_tool',
    'write',
]);
const TOOL_STATUS_PHRASES: Record<string, string> = {
    read: 'reading files',
    view: 'reading files',
    file_read: 'reading files',
    cat: 'reading files',
    write: 'editing files',
    create: 'editing files',
    file_write: 'editing files',
    edit: 'editing files',
    multiedit: 'editing files',
    apply_patch: 'editing files',
    str_replace: 'editing files',
    str_replace_based_edit_tool: 'editing files',
    bash: 'executing commands',
    shell: 'executing commands',
    cmd: 'executing commands',
    terminal: 'executing commands',
    grep: 'searching code',
    search: 'searching code',
    find: 'searching files',
    ripgrep: 'searching code',
    glob: 'searching files',
    list: 'listing files',
    ls: 'listing files',
    dir: 'listing files',
    list_files: 'listing files',
    task: 'delegating work',
    subagent: 'delegating work',
    webfetch: 'fetching a URL',
    fetch: 'fetching a URL',
    websearch: 'searching the web',
    web_search: 'searching the web',
    search_web: 'searching the web',
    codesearch: 'searching code',
    todowrite: 'updating tasks',
    todoread: 'reviewing tasks',
    skill: 'loading a skill',
    question: 'waiting for input',
    lsp: 'inspecting code',
    structuredoutput: 'formatting the response',
    structured_output: 'formatting the response',
    pichamber: 'working in PiChamber',
    plan_enter: 'switching to planning',
    plan_exit: 'switching to building',
};
const WORKING_PHRASES = [
    'working',
    'processing',
    'preparing',
    'warming up',
    'gears turning',
    'computing',
    'calculating',
    'analyzing',
    'wheels spinning',
    'calibrating',
    'synthesizing',
    'connecting dots',
    'inspecting logic',
    'weighing options',
];

type ParsedStatusResult = {
    activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined;
    activeToolName: string | undefined;
    statusText: string;
    isGenericStatus: boolean;
};

const normalizeStatusToolName = (toolName: string): string => {
    const trimmed = toolName.trim().toLowerCase().replace(/:\d+$/, '');
    if (!trimmed.includes('.')) return trimmed;
    const segments = trimmed.split('.').filter(Boolean);
    return segments[segments.length - 1] ?? trimmed;
};

const getToolStatusPhrase = (toolName: string): string => {
    const normalized = normalizeStatusToolName(toolName);
    return TOOL_STATUS_PHRASES[normalized] ?? `using ${normalized.replaceAll('_', ' ')}`;
};

const hashString = (value: string): number => {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
};

const getStableWorkingPhrase = (key: string): string => {
    return WORKING_PHRASES[hashString(key) % WORKING_PHRASES.length] ?? 'working';
};

const isToolPart = (part: Part): part is ToolPart => part.type === 'tool';

export const getAssistantActivityStatus = (parts: Part[], genericKey: string): ParsedStatusResult => {
    let activePartType: ParsedStatusResult['activePartType'] = undefined;
    let activeToolName: string | undefined = undefined;

    if (!isFullySyntheticMessage(parts)) {
        for (let index = parts.length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (!part) continue;

            switch (part.type) {
                case 'reasoning': {
                    const time = getPartTimeInfo(part);
                    const stillRunning = !time || typeof time.end === 'undefined';
                    if (stillRunning && !activePartType) {
                        activePartType = 'reasoning';
                    }
                    break;
                }
                case 'tool': {
                    if (!isToolPart(part)) break;
                    const toolStatus = part.state?.status;
                    if ((toolStatus === 'running' || toolStatus === 'pending') && !activePartType) {
                        const toolName = normalizeStatusToolName(getToolDisplayName(part));
                        if (EDITING_TOOLS.has(toolName)) {
                            activePartType = 'editing';
                            activeToolName = toolName;
                        } else {
                            activePartType = 'tool';
                            activeToolName = toolName;
                        }
                    }
                    break;
                }
                case 'text': {
                    const rawContent = getLegacyTextContent(part) ?? '';
                    if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
                        const time = getPartTimeInfo(part);
                        const streamingPart = !time || typeof time.end === 'undefined';
                        if (streamingPart && !activePartType) {
                            activePartType = 'text';
                        }
                    }
                    break;
                }
                default:
                    break;
            }
        }
    }

    const isGenericStatus = activePartType === undefined;
    const statusText = (() => {
        if (activePartType === 'editing' && activeToolName) return getToolStatusPhrase(activeToolName);
        if (activePartType === 'tool' && activeToolName) return getToolStatusPhrase(activeToolName);
        if (activePartType === 'reasoning') return 'thinking';
        if (activePartType === 'text') return 'writing response';
        return getStableWorkingPhrase(genericKey);
    })();

    return { activePartType, activeToolName, statusText, isGenericStatus };
};

export const getPiAssistantActivityStatus = (
    parts: Pick<ReadonlyMap<string, PiReducerMessagePart>, 'get'>,
    partOrder: readonly string[],
    genericKey: string,
): ParsedStatusResult => {
    for (let index = partOrder.length - 1; index >= 0; index -= 1) {
        const partId = partOrder[index];
        const part = partId ? parts.get(partId) : undefined;
        if (!part) continue;

        if (part.type === 'tool' && (part.tool?.state === 'running' || part.tool?.state === 'pending')) {
            const activeToolName = normalizeStatusToolName(part.tool.name);
            return {
                activePartType: EDITING_TOOLS.has(activeToolName) ? 'editing' : 'tool',
                activeToolName,
                statusText: getToolStatusPhrase(activeToolName),
                isGenericStatus: false,
            };
        }

        if (part.type === 'thinking' && part.streaming) {
            return {
                activePartType: 'reasoning',
                activeToolName: undefined,
                statusText: 'thinking',
                isGenericStatus: false,
            };
        }

        if (part.type === 'text' && part.streaming && part.text.trim().length > 0) {
            return {
                activePartType: 'text',
                activeToolName: undefined,
                statusText: 'writing response',
                isGenericStatus: false,
            };
        }
    }

    return {
        activePartType: undefined,
        activeToolName: undefined,
        statusText: getStableWorkingPhrase(genericKey),
        isGenericStatus: true,
    };
};

const encodeParsedStatus = (status: ParsedStatusResult): string => {
    return [
        status.activePartType ?? '',
        status.activeToolName ?? '',
        status.statusText,
        status.isGenericStatus ? '1' : '0',
    ].join(STATUS_SIGNATURE_SEPARATOR);
};

const decodeParsedStatus = (signature: string): ParsedStatusResult => {
    const [activePartType, activeToolName, statusText = 'working', isGenericStatus] = signature.split(STATUS_SIGNATURE_SEPARATOR);
    return {
        activePartType: activePartType === 'text' || activePartType === 'tool' || activePartType === 'reasoning' || activePartType === 'editing'
            ? activePartType
            : undefined,
        activeToolName: activeToolName || undefined,
        statusText,
        isGenericStatus: isGenericStatus === '1',
    };
};

const isTextPart = (part: Part): part is TextPart => part.type === 'text';

const getLegacyTextContent = (part: Part): string | undefined => {
    if (isTextPart(part)) {
        return part.text;
    }
    const candidate = part as Partial<{ text?: unknown; content?: unknown; value?: unknown }>;
    if (typeof candidate.text === 'string') {
        return candidate.text;
    }
    if (typeof candidate.content === 'string') {
        return candidate.content;
    }
    if (typeof candidate.value === 'string') {
        return candidate.value;
    }
    return undefined;
};

const getPartTimeInfo = (part: Part): { end?: number } | undefined => {
    const rawTime = (part as { time?: unknown }).time;
    if (!rawTime || typeof rawTime !== 'object') return undefined;
    const end = (rawTime as Record<string, unknown>).end;
    return { end: typeof end === 'number' ? end : undefined };
};

const getToolDisplayName = (part: ToolPart): string => {
    if (part.tool) {
        return part.tool;
    }
    const candidate = part as ToolPart & Partial<{ name?: unknown }>;
    return typeof candidate.name === 'string' ? candidate.name : 'tool';
};

export const getActiveAssistantContext = (messages: Message[]): ActiveAssistantContext => {
    let assistantId: string | null = null;
    let parentId: string | null = null;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;

        const candidate = message as Message & { parentID?: unknown };
        assistantId = message.id;
        parentId = typeof candidate.parentID === 'string' && candidate.parentID.trim().length > 0
            ? candidate.parentID
            : null;
        break;
    }

    if (!assistantId || !parentId) {
        return { assistantId, model: null };
    }

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user' || message.id !== parentId) continue;

        const candidate = message as Message & {
            model?: { providerID?: unknown; modelID?: unknown };
        };
        const providerId = typeof candidate.model?.providerID === 'string'
            ? candidate.model.providerID.trim()
            : '';
        const modelId = typeof candidate.model?.modelID === 'string'
            ? candidate.model.modelID.trim()
            : '';

        return {
            assistantId,
            model: providerId && modelId ? { providerId, modelId } : null,
        };
    }

    return { assistantId, model: null };
};

export function useAssistantStatus(): AssistantStatusSnapshot {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);

    const rawSessionMessages = useSessionMessages(
        currentSessionId ?? '',
        currentSessionDirectory ?? undefined,
    );

    const activeAssistant = React.useMemo(
        () => getActiveAssistantContext(rawSessionMessages),
        [rawSessionMessages],
    );
    const lastAssistantId = activeAssistant.assistantId;

    const lastAssistantStatusSignature = usePiSessionSnapshot(
        React.useCallback((state) => {
            const genericKey = `${currentSessionId ?? ''}:${lastAssistantId ?? ''}`;
            const session = currentSessionId
                ? state.reducer.bySession.get(currentSessionId)
                : undefined;
            // Transcript records intentionally freeze their live tail. Always
            // prefer the reducer's authoritative streaming assistant so a new
            // thinking/tool part does not wait for that frozen record to publish.
            const statusAssistantId = selectStreamingAssistantMessageId(session) ?? lastAssistantId;
            const partOrder = statusAssistantId
                ? (session?.partOrder.get(statusAssistantId) ?? [])
                : [];
            const parsedStatus = session
                ? getPiAssistantActivityStatus(session.parts, partOrder, genericKey)
                : getPiAssistantActivityStatus(EMPTY_PI_PARTS, [], genericKey);
            return encodeParsedStatus(parsedStatus);
        }, [currentSessionId, lastAssistantId]),
        undefined,
        currentSessionId ? `session:${currentSessionId}` : 'chrome',
    );

    const sessionPermissionRequests = useSessionPermissions(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const sessionQuestionRequests = useSessionQuestions(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionAbortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
        }, [currentSessionId])
    );

    const { phase: activityPhase, isWorking: isPhaseWorking } = useCurrentSessionActivity();

    const currentSessionStatus = useSessionStatus(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionRetryAttempt = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; attempt?: number }).attempt
        : undefined;

    const sessionRetryNext = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; next?: number }).next
        : undefined;

    const parsedStatus = React.useMemo<ParsedStatusResult>(() => {
        return decodeParsedStatus(lastAssistantStatusSignature);
    }, [lastAssistantStatusSignature]);

    const abortState = React.useMemo(() => {
        const hasActiveAbort = Boolean(sessionAbortRecord && !sessionAbortRecord.acknowledged);
        return { wasAborted: hasActiveAbort, abortActive: hasActiveAbort };
    }, [sessionAbortRecord]);

    const baseWorking = React.useMemo<WorkingSummary>(() => {

        if (abortState.wasAborted) {
            return {
                ...DEFAULT_WORKING,
                wasAborted: true,
                abortActive: abortState.abortActive,
                activity: 'idle',
                hasWorkingContext: false,
                isWorking: false,
                isStreaming: false,
                isCooldown: false,
                statusText: null,
                canAbort: false,
                retryInfo: null,
            };
        }

        const isWorking = isPhaseWorking;
        const isStreaming = activityPhase === 'busy';
        const isCooldown = false;
        const isRetry = activityPhase === 'retry';

        let activity: AssistantActivity = 'idle';
        if (isWorking) {
            if (parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing') {
                activity = 'tooling';
            } else {
                activity = isCooldown ? 'cooldown' : 'streaming';
            }
        }

        const retryInfo = isRetry
            ? { attempt: sessionRetryAttempt, next: sessionRetryNext }
            : null;

        return {
            activity,
            hasWorkingContext: isWorking,
            hasActiveTools: parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing',
            isWorking,
            isStreaming,
            isCooldown,
            lifecyclePhase: isStreaming ? 'streaming' : isCooldown ? 'cooldown' : null,
            statusText: isWorking ? parsedStatus.statusText : null,
            isGenericStatus: isWorking ? parsedStatus.isGenericStatus : true,
            isWaitingForPermission: false,
            canAbort: isWorking,
            compactionDeadline: null,
            activePartType: isWorking ? parsedStatus.activePartType : undefined,
            activeToolName: isWorking ? parsedStatus.activeToolName : undefined,
            wasAborted: false,
            abortActive: false,
            lastCompletionId: null,
            isComplete: false,
            retryInfo,
        };
    }, [activityPhase, isPhaseWorking, parsedStatus, abortState, sessionRetryAttempt, sessionRetryNext]);

    const forming = React.useMemo<FormingSummary>(() => {
        const isActive = isPhaseWorking && parsedStatus.activePartType === 'text';
        return { isActive, characterCount: 0 };
    }, [isPhaseWorking, parsedStatus.activePartType]);

    const working = React.useMemo<WorkingSummary>(() => {
        if (baseWorking.wasAborted || baseWorking.abortActive) {
            return baseWorking;
        }

        const hasPendingPermission = sessionPermissionRequests.length > 0;
        const hasPendingQuestion = sessionQuestionRequests.length > 0;

        if (!hasPendingPermission && !hasPendingQuestion) {
            return baseWorking;
        }

        if (hasPendingQuestion) {
            return {
                ...baseWorking,
                statusText: null,
                isWorking: false,
                hasWorkingContext: false,
                hasActiveTools: false,
                canAbort: false,
                activePartType: undefined,
                activeToolName: undefined,
                retryInfo: null,
            };
        }

        return {
            ...baseWorking,
            statusText: 'waiting for permission',
            isWaitingForPermission: true,
            canAbort: false,
            retryInfo: null,
        };
    }, [baseWorking, sessionPermissionRequests, sessionQuestionRequests]);

    return {
        activeModel: activeAssistant.model,
        forming,
        working,
    };
}
