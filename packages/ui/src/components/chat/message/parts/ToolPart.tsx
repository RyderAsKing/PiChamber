
import React from 'react';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { cn } from '@/lib/utils';
import { getToolMetadata } from '@/lib/toolHelpers';
import type { ToolPart as ToolPartType } from '@/lib/chat/types';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionMessageRecords, useEnsureSessionMessages, useSessionReducerPart } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { Text } from '@/components/ui/text';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ToolPopupContent } from '../types';

import { Icon } from "@/components/icon/Icon";
import { MinDurationShineText } from './MinDurationShineText';
import { getToolIcon } from './toolPresentation';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import {
    buildTaskSummaryEntriesFromSession,
    normalizeTaskSummaryEntries,
    parseTaskMetadataBlock,
    readTaskSessionIdFromOutput,
    readTaskSessionIdFromRecord,
    shouldHydrateTaskChildSession,
    getTaskSummaryEntryRenderSignature,
    type TaskToolSummaryEntry,
} from './taskToolModel';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import {
    getFirstChangedLineFromMetadata,
    getMutatedToolPaths,
    getPrimaryToolPath,
} from './toolDiffUtils';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import {
    getRelativePath,
    getToolDescription,
    getToolDescriptionPath,
    normalizeToolName,
    parseDiffStats,
    parseWriteLineCount,
    type ToolStateWithMetadata,
} from './toolRenderUtils';
import { ApplyPatchFileButtons } from './ApplyPatchFileButtons';
import { openApplyPatchFileInEditor } from './applyPatchEditorAction';
import { TaskToolSummary } from './TaskToolSummary';
import { ToolExpandedContent } from './ToolExpandedContent';
import { useDeferredExpandedContent } from './useDeferredExpandedContent';
import { AnimatedToolPath } from './ToolPartChrome';
import {
    TOOL_ERROR_ICON_STYLE,
    TOOL_ERROR_TITLE_STYLE,
    TOOL_NORMAL_ICON_STYLE,
    TOOL_NORMAL_TITLE_STYLE,
    TOOL_ROW_DESCRIPTION_CLASS,
    TOOL_ROW_TITLE_CLASS,
} from './toolPartStyles';


interface ToolPartProps {
    part: ToolPartType;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    isMobile: boolean;
    alwaysShowActions?: boolean;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
}


const GIT_REFRESH_MUTATING_TOOLS = new Set([
    'bash',
    'edit',
    'write',
    'apply_patch',
    'patch',
]);

const formatDuration = (start: number, end?: number, now: number = Date.now()) => {
    const duration = Math.max(0, (end ?? now) - start);
    const seconds = duration / 1000;

    const displaySeconds = seconds < 0.05 && end !== undefined ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

const LiveDuration: React.FC<{ start: number; end?: number; active: boolean }> = ({ start, end, active }) => {
    const now = useDurationTickerNow(active, 250);

    return <>{formatDuration(start, end, now)}</>;
};


const ToolPartContent: React.FC<ToolPartProps> = ({
    part,
    isExpanded,
    onToggle,
    isMobile,
    onContentChange,
    onShowPopup,
    animateTailText = true,
}) => {
    const sessionId = useSessionUIStore((store) => store.currentSessionId);
    const deferredBody = (part.state as { deferredBody?: unknown } | undefined)?.deferredBody === true;
    const hydratedPart = useSessionReducerPart(sessionId, part.id, isExpanded && deferredBody);
    const resolvedPart = (
      isExpanded
      && hydratedPart
      && hydratedPart.type === 'tool'
    ) ? hydratedPart as ToolPartType : part;
    const state = resolvedPart.state;
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const showToolFileIcons = useUIStore((s) => s.showToolFileIcons);
    const currentDirectory = useEffectiveDirectory() ?? '';

    const normalizedPartTool = normalizeToolName(part.tool);
    const isTaskTool = normalizedPartTool === 'task';

    const status = state?.status as string | undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    const isSuccessfullyFinalized = status === 'completed';
    const isError = status === 'error' || status === 'failed';

    const [activeLatched, setActiveLatched] = React.useState<boolean>(!isFinalized);
    const previousPartIdRef = React.useRef<string | undefined>(part.id);
    const observedActiveGitToolRef = React.useRef(!isFinalized);

    React.useEffect(() => {
        if (previousPartIdRef.current === part.id) {
            return;
        }
        previousPartIdRef.current = part.id;
        observedActiveGitToolRef.current = !isFinalized;
        // Reset latch only when tool identity changes.
        setActiveLatched(!isFinalized);
    }, [isFinalized, part.id]);

    React.useEffect(() => {
        if (!isFinalized) {
            setActiveLatched(true);
        }
    }, [isFinalized]);

    React.useEffect(() => {
        if (!isFinalized) {
            observedActiveGitToolRef.current = true;
            return;
        }

        // Historical completed tools can remount when the timeline changes.
        // Refresh only for a tool whose active state this instance observed.
        const finalizedAfterObservedActive = observedActiveGitToolRef.current;
        if (!finalizedAfterObservedActive) {
            return;
        }

        if (!isSuccessfullyFinalized || !GIT_REFRESH_MUTATING_TOOLS.has(normalizedPartTool)) {
            observedActiveGitToolRef.current = false;
            return;
        }
        if (!currentDirectory) {
            return;
        }

        observedActiveGitToolRef.current = false;
        const paths = getMutatedToolPaths(normalizedPartTool, input, metadata)
            .map((path) => getRelativePath(path, currentDirectory));
        sessionEvents.requestGitRefresh({
            directory: currentDirectory,
            ...(paths.length > 0 ? { paths } : {}),
        });
    }, [currentDirectory, input, isFinalized, isSuccessfullyFinalized, metadata, normalizedPartTool]);

    const shouldNotifyStructuralChange = isFinalized || isTaskTool;

    const onContentChangeRef = React.useRef(onContentChange);
    onContentChangeRef.current = onContentChange;
    const expandedContentRef = React.useRef<HTMLDivElement>(null);

    React.useLayoutEffect(() => {
        if (isTaskTool) {
            return;
        }

        const element = expandedContentRef.current;
        if (!element) {
            return;
        }

        element.style.height = isExpanded ? 'auto' : '0px';
        element.style.overflow = isExpanded ? 'visible' : 'hidden';

        if (shouldNotifyStructuralChange) {
            onContentChangeRef.current?.('structural');
        }
    }, [isExpanded, isTaskTool, shouldNotifyStructuralChange]);

    const partMetadata = (part as unknown as { metadata?: unknown }).metadata;
    const time = stateWithData.time;

    const [pinnedTime, setPinnedTime] = React.useState<{ start?: number; end?: number }>(() => ({
        start: typeof time?.start === 'number' ? time.start : undefined,
        end: typeof time?.end === 'number' ? time.end : undefined,
    }));
    const [localStartAt, setLocalStartAt] = React.useState<number | undefined>(undefined);
    const [localFinalizedAt, setLocalFinalizedAt] = React.useState<number | undefined>(undefined);

    React.useEffect(() => {
        setPinnedTime({});
        setLocalStartAt(undefined);
        setLocalFinalizedAt(undefined);
    }, [part.id]);

    React.useEffect(() => {
        if (isFinalized) {
            return;
        }
        if (typeof time?.start === 'number') {
            return;
        }
        setLocalStartAt((prev) => prev ?? Date.now());
    }, [isFinalized, time?.start]);

    React.useEffect(() => {
        setPinnedTime((prev) => {
            const next = { ...prev };
            let changed = false;

            if (typeof time?.start === 'number' && (typeof prev.start !== 'number' || time.start < prev.start)) {
                next.start = time.start;
                changed = true;
            }

            if (typeof time?.end === 'number' && (typeof prev.end !== 'number' || time.end > prev.end)) {
                next.end = time.end;
                changed = true;
            }

            return changed ? next : prev;
        });
    }, [time?.end, time?.start]);

    const effectiveTimeStart = React.useMemo(() => {
        // Once we captured a local start (during pending, before server sends time.start),
        // always prefer it so the timer never jumps when server start arrives later.
        if (typeof localStartAt === 'number') {
            return localStartAt;
        }
        const candidates = [pinnedTime.start, time?.start].filter(
            (value): value is number => typeof value === 'number'
        );
        if (candidates.length === 0) {
            return undefined;
        }
        return Math.min(...candidates);
    }, [localStartAt, pinnedTime.start, time?.start]);

    const taskOutputString = React.useMemo(() => {
        return typeof stateWithData.output === 'string' ? stateWithData.output : undefined;
    }, [stateWithData.output]);

    const parsedTaskMetadata = React.useMemo(() => {
        return parseTaskMetadataBlock(taskOutputString);
    }, [taskOutputString]);

    const metadataTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool) {
            return [];
        }
        const candidateSummary = (metadata as { summary?: unknown; entries?: unknown; tools?: unknown; calls?: unknown } | undefined);
        const normalized = normalizeTaskSummaryEntries(
            candidateSummary?.summary ?? candidateSummary?.entries ?? candidateSummary?.tools ?? candidateSummary?.calls
        );

        if (normalized.length > 0) {
            return normalized;
        }

        return parsedTaskMetadata.summaryEntries;
    }, [isTaskTool, metadata, parsedTaskMetadata.summaryEntries]);

    const hasFinalMetadataTaskSummary = isFinalized && metadataTaskSummaryEntries.length > 0;

    const taskSessionId = React.useMemo<string | undefined>(() => {
        if (!isTaskTool) {
            return undefined;
        }

        // Pi publishes this authoritative join while the Task is
        // running. The remaining sources only support older persisted parts.
        const metadataSessionId = readTaskSessionIdFromRecord(metadata);
        if (metadataSessionId) {
            return metadataSessionId;
        }

        const partLevelSessionId = readTaskSessionIdFromRecord(partMetadata);
        if (partLevelSessionId) {
            return partLevelSessionId;
        }

        if (parsedTaskMetadata.sessionId) {
            return parsedTaskMetadata.sessionId;
        }
        return readTaskSessionIdFromOutput(taskOutputString);
    }, [isTaskTool, metadata, parsedTaskMetadata.sessionId, partMetadata, taskOutputString]);

    React.useEffect(() => {
        if (typeof time?.end === 'number' || typeof pinnedTime.end === 'number') {
            setLocalFinalizedAt(undefined);
            return;
        }

        if (typeof effectiveTimeStart !== 'number') {
            return;
        }

        if (!isFinalized) {
            return;
        }

        setLocalFinalizedAt((prev) => prev ?? Date.now());
    }, [
        effectiveTimeStart,
        isFinalized,
        pinnedTime.end,
        time?.end,
    ]);

    const effectiveTimeEnd = isFinalized ? (pinnedTime.end ?? time?.end ?? localFinalizedAt) : undefined;
    const isActive = !isFinalized && activeLatched;
    const shouldTreatAsFinalized = isFinalized;
    const childSessionLookupId = shouldHydrateTaskChildSession({
        isTaskTool,
        isExpanded,
        isActive,
        hasFinalMetadataSummary: hasFinalMetadataTaskSummary,
        taskSessionId,
    }) ? (taskSessionId ?? '') : '';

    const childSessionMessages = useSessionMessageRecords(childSessionLookupId, currentDirectory);
    useEnsureSessionMessages(childSessionLookupId, currentDirectory);

    const childSessionTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!isTaskTool || !taskSessionId) {
            return [];
        }
        if (!Array.isArray(childSessionMessages) || childSessionMessages.length === 0) {
            return [];
        }
        return buildTaskSummaryEntriesFromSession(childSessionMessages as unknown as Parameters<typeof buildTaskSummaryEntriesFromSession>[0]);
    }, [childSessionMessages, isTaskTool, taskSessionId]);

    const taskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (childSessionTaskSummaryEntries.length > 0) {
            return childSessionTaskSummaryEntries;
        }
        return metadataTaskSummaryEntries;
    }, [childSessionTaskSummaryEntries, metadataTaskSummaryEntries]);
    const taskSummaryRenderSignature = React.useMemo(() => {
        return taskSummaryEntries.map(getTaskSummaryEntryRenderSignature).join('\u0000');
    }, [taskSummaryEntries]);
    const lastTaskSummaryRenderSignatureRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!isTaskTool) {
            lastTaskSummaryRenderSignatureRef.current = null;
            return;
        }

        const previous = lastTaskSummaryRenderSignatureRef.current;
        lastTaskSummaryRenderSignatureRef.current = taskSummaryRenderSignature;
        if (previous === null || previous === taskSummaryRenderSignature || taskSummaryEntries.length === 0) {
            return;
        }

        onContentChangeRef.current?.('structural');
    }, [isTaskTool, taskSummaryEntries.length, taskSummaryRenderSignature]);

    const diffStats = React.useMemo(() => {
        return (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'apply_patch')
            ? parseDiffStats(metadata)
            : null;
    }, [metadata, normalizedPartTool]);
    const writeLineCount = React.useMemo(() => {
        return normalizedPartTool === 'write' ? parseWriteLineCount(input) : null;
    }, [input, normalizedPartTool]);
    const isMultiFileApplyPatch = normalizedPartTool === 'apply_patch' && Array.isArray(metadata?.files) && (metadata?.files as []).length > 1;
    const normalizedPart = normalizedPartTool !== part.tool ? ({ ...part, tool: normalizedPartTool } as ToolPartType) : part;
    const descriptionPath = state ? getToolDescriptionPath(normalizedPart, state, currentDirectory) : undefined;
    const description = state ? getToolDescription(normalizedPart, state, currentDirectory) : undefined;
    const displayName = getToolMetadata(normalizedPartTool || part.tool || '').displayName;
    
    // Tool title/description — shown inline as context
    const justificationText = React.useMemo(() => {
        if (normalizedPartTool === 'bash') {
            return null;
        }
        if (normalizedPartTool === 'apply_patch') {
            return null;
        }
        if (normalizedPartTool === 'lsp') {
            return null;
        }
        if (
            descriptionPath
            && (normalizedPartTool === 'apply_patch' || normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit' || normalizedPartTool === 'write')
        ) {
            return null;
        }
        const title = (stateWithData as { title?: string }).title;
        if (typeof title === 'string' && title.trim().length > 0) {
            return title;
        }
        const inputDesc = input?.description;
        if (typeof inputDesc === 'string' && inputDesc.trim().length > 0) {
            return inputDesc;
        }
        return null;
    }, [descriptionPath, normalizedPartTool, stateWithData, input]);
    const hasToolContext = Boolean(justificationText || description || diffStats || writeLineCount);
    const runtime = React.useContext(RuntimeAPIContext);

    const openApplyPatchFile = (file: Record<string, unknown>, event: React.MouseEvent<HTMLButtonElement>) => {
        if (!runtime?.editor) {
            return;
        }

        event.stopPropagation();
        openApplyPatchFileInEditor({
            currentDirectory,
            editor: runtime.editor,
            file,
        });
    };

    const handleMainClick = (e: { stopPropagation: () => void }) => {
        if (isTaskTool || !runtime?.editor) {
            onToggle(part.id);
            return;
        }

        let filePath: unknown;
        let targetLine: number | undefined;
        if (normalizedPartTool === 'edit' || normalizedPartTool === 'multiedit') {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
            if (typeof filePath === 'string') {
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (normalizedPartTool === 'apply_patch') {
            filePath = getPrimaryToolPath(normalizedPartTool, input, metadata);
            if (typeof filePath === 'string') {
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (['write', 'create', 'file_write'].includes(normalizedPartTool)) {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
        } else if (normalizedPartTool === 'lsp') {
            filePath = input?.filePath || input?.file_path || input?.path;
            const line = input?.line;
            targetLine = typeof line === 'number' && Number.isFinite(line) ? Math.trunc(line) : undefined;
        }

        if (typeof filePath === 'string') {
            e.stopPropagation();
            const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
            runtime.editor.openFile(absolutePath, targetLine);
        } else {
            onToggle(part.id);
        }
    };

    const handleMainKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handleMainClick(event);
    };

    const iconStyle = !isTaskTool && isError ? TOOL_ERROR_ICON_STYLE : TOOL_NORMAL_ICON_STYLE;
    const titleStyle = !isTaskTool && isError ? TOOL_ERROR_TITLE_STYLE : TOOL_NORMAL_TITLE_STYLE;
    const shouldRenderTaskSummary = useDeferredExpandedContent(isTaskTool && (taskSummaryEntries.length > 0 || isActive || shouldTreatAsFinalized || !!taskSessionId));
    const shouldRenderExpandedContent = useDeferredExpandedContent(!isTaskTool && isExpanded);

    if (!shouldTreatAsFinalized && !isActive && !isTaskTool) {
        return null;
    }

    return (
        <div>
            {}
            <div
                className={cn(
                    // Live rows, not cards: tight single-line rows.
                    'group/tool flex w-full min-w-0 gap-x-1.5 rounded-md pr-2 pl-px py-1 transition-colors hover:bg-[var(--interactive-hover)]',
                    isMultiFileApplyPatch ? 'flex-wrap items-start cursor-pointer' : 'items-center cursor-pointer',
                )}
                onClick={isMultiFileApplyPatch ? () => onToggle(part.id) : handleMainClick}
                onKeyDown={isMultiFileApplyPatch ? (event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    onToggle(part.id);
                } : handleMainKeyDown}
                role="button"
                tabIndex={0}
            >
                <div className={cn('flex min-w-0', isMultiFileApplyPatch ? 'w-full flex-wrap items-center gap-x-2 gap-y-0.5' : 'flex-shrink-0 items-center gap-x-1.5')}>
                    {isMultiFileApplyPatch ? (
                        <>
                            <div className="flex h-5 flex-shrink-0 items-center gap-1.5">
                                <span className="relative h-3.5 w-3.5 flex-shrink-0">
                                    <span className={cn(
                                        'absolute inset-0 flex items-center justify-center transition-opacity',
                                        isExpanded ? 'opacity-0' : 'group-hover/tool:opacity-0',
                                    )} style={iconStyle}>
                                        {getToolIcon(normalizedPartTool || part.tool)}
                                    </span>
                                    <Icon
                                        name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                                        className={cn(
                                            'absolute inset-0 h-3.5 w-3.5 transition-opacity',
                                            isExpanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
                                        )}
                                    />
                                </span>
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                    style={titleStyle}
                                >
                                    {displayName}
                                </MinDurationShineText>
                            </div>
                            <ApplyPatchFileButtons
                                metadata={metadata}
                                animate={animateTailText}
                                showFileIcons={showToolFileIcons}
                                textClassName={TOOL_ROW_DESCRIPTION_CLASS}
                                openDiffLabel={"Open file diff"}
                                onFileClick={runtime?.editor ? openApplyPatchFile : undefined}
                            />
                            {typeof effectiveTimeStart === 'number' ? (
                                <span className={cn('ml-auto flex-shrink-0 tabular-nums text-muted-foreground/80', TOOL_ROW_DESCRIPTION_CLASS)} aria-label="Tool duration">
                                    <LiveDuration
                                        start={effectiveTimeStart}
                                        end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                                        active={Boolean(isActive && typeof effectiveTimeEnd !== 'number')}
                                    />
                                </span>
                            ) : null}
                        </>
                    ) : (
                        <>
                            <div
                                // h-5 matches StaticToolRow's icon column, so expandable
                                // and static rows come out the same height (the 14px
                                // icon alone left these rows ~2px shorter).
                                className="relative h-5 w-3.5 flex-shrink-0 cursor-pointer"
                                onClick={(event) => { event.stopPropagation(); onToggle(part.id); }}
                            >
                                <div
                                    className={cn(
                                        'absolute inset-0 flex items-center justify-center transition-opacity',
                                        isExpanded && 'opacity-0',
                                        !isExpanded && 'group-hover/tool:opacity-0'
                                    )}
                                    style={iconStyle}
                                >
                                    {getToolIcon(normalizedPartTool || part.tool || '')}
                                </div>
                                <div
                                    className={cn(
                                        'absolute inset-0 transition-opacity flex items-center justify-center',
                                        isExpanded && 'opacity-100',
                                        !isExpanded && 'opacity-0 group-hover/tool:opacity-100'
                                    )}
                                >
                                    {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                                </div>
                            </div>
                            <div className="flex min-w-0 flex-shrink-0 items-center gap-x-1.5">
                                <MinDurationShineText
                                    active={Boolean(isActive && !isError)}
                                    minDurationMs={300}
                                    className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')}
                                    style={titleStyle}
                                    title={displayName}
                                >
                                    {displayName}
                                </MinDurationShineText>
                            </div>
                        </>
                    )}
                </div>

                {!isMultiFileApplyPatch && hasToolContext ? (
                    <div
                        className={cn('flex min-w-0 flex-1 items-center', TOOL_ROW_DESCRIPTION_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                    >
                        <span
                            className={cn(
                                'inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5',
                                TOOL_ROW_DESCRIPTION_CLASS,
                            )}
                        >
                            <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                            {justificationText && (
                                <span
                                    className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                                    style={{ color: 'var(--tools-description)', opacity: 0.8 }}
                                    title={justificationText}
                                >
                                    {justificationText}
                                </span>
                            )}
                            {!justificationText && normalizedPartTool === 'lsp' && descriptionPath ? (
                                <AnimatedToolPath path={descriptionPath} animate={animateTailText} grow={false} showFileIcons={showToolFileIcons} />
                            ) : null}
                            {!justificationText && normalizedPartTool !== 'lsp' && description && (
                                descriptionPath && description === descriptionPath ? (
                                    <AnimatedToolPath path={descriptionPath} animate={animateTailText} grow={false} showFileIcons={showToolFileIcons} />
                                ) : (
                                    <Text
                                        variant={animateTailText ? 'generate-effect' : 'static'}
                                        className={cn('min-w-0 truncate', TOOL_ROW_DESCRIPTION_CLASS)}
                                        style={{ color: 'var(--tools-description)' }}
                                        title={description}
                                    >
                                        {description}
                                    </Text>
                                )
                            )}
                            {diffStats && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                    <span style={{ color: 'var(--status-success)' }}>+{diffStats.added}</span>
                                    <span style={{ color: 'var(--tools-description)' }}>/</span>
                                    <span style={{ color: 'var(--status-error)' }}>-{diffStats.removed}</span>
                                </span>
                            )}
                            {writeLineCount && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                    <span style={{ color: 'var(--status-success)' }}>+{writeLineCount}</span>
                                </span>
                            )}
                            </span>
                        </span>
                    </div>
                ) : null}
                {!isMultiFileApplyPatch && typeof effectiveTimeStart === 'number' ? (
                    <span className={cn('ml-auto flex-shrink-0 tabular-nums text-muted-foreground/80', TOOL_ROW_DESCRIPTION_CLASS)} aria-label="Tool duration">
                        <LiveDuration
                            start={effectiveTimeStart}
                            end={typeof effectiveTimeEnd === 'number' ? effectiveTimeEnd : undefined}
                            active={Boolean(isActive && typeof effectiveTimeEnd !== 'number')}
                        />
                    </span>
                ) : null}
            </div>

            {}
            {shouldRenderTaskSummary ? (
                <TaskToolSummary
                    entries={taskSummaryEntries}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    output={taskOutputString}
                    sessionId={taskSessionId}
                    onShowPopup={onShowPopup}
                    input={input}
                    animateTailText={animateTailText}
                    isActive={isActive}
                />
            ) : null}

            {!isTaskTool ? (
                <div
                    ref={expandedContentRef}
                    aria-hidden={!isExpanded}
                    style={{
                        height: isExpanded ? 'auto' : '0px',
                        overflow: isExpanded ? 'visible' : 'hidden',
                        overflowAnchor: 'none',
                    }}
                >
                    {shouldRenderExpandedContent ? (
                        <div
                            className="relative ml-2 pl-3"
                        >
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                                style={{ backgroundColor: 'var(--tools-border)' }}
                            />
                            {state ? (
                                <ToolExpandedContent
                                    part={resolvedPart}
                                    state={state}
                                    currentDirectory={currentDirectory}
                                    isExpanded={isExpanded}
                                    onShowPopup={onShowPopup}
                                />
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};

class ToolPartErrorBoundary extends React.Component<{
    children: React.ReactNode;
    displayName: string;
    errorLabel: string;
    resetKey: unknown;
    toolName: string;
}, { hasError: boolean; error?: Error }> {
    state: { hasError: boolean; error?: Error } = { hasError: false };

    static getDerivedStateFromError(error: Error): { hasError: boolean; error: Error } {
        return { hasError: true, error };
    }

    componentDidUpdate(prevProps: { resetKey: unknown }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false, error: undefined });
        }
    }

    componentDidCatch(error: Error) {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Tool part failed to render; showing safe fallback.', error);
        }
    }

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const message = this.state.error?.message;
        return (
            <div className="flex items-center gap-1.5 pr-2 pl-px py-1 min-w-0">
                <div className="h-3.5 w-3.5 flex-shrink-0" style={TOOL_ERROR_ICON_STYLE}>
                    {getToolIcon(this.props.toolName)}
                </div>
                <span className={cn(TOOL_ROW_TITLE_CLASS, 'flex-shrink-0')} style={TOOL_ERROR_TITLE_STYLE}>
                    {this.props.displayName}
                </span>
                {message ? (
                    <span className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'min-w-0 truncate')} style={{ color: 'var(--tools-description)' }} title={message}>
                        {this.props.errorLabel}: {message}
                    </span>
                ) : null}
            </div>
        );
    }
}

const ToolPart: React.FC<ToolPartProps> = (props) => {
    const toolName = normalizeToolName(props.part.tool) || 'tool';
    const displayName = getToolMetadata(toolName).displayName;

    return (
        <ToolPartErrorBoundary
            displayName={displayName}
            errorLabel={"Error:"}
            resetKey={props.part}
            toolName={toolName}
        >
            <ToolPartContent {...props} />
        </ToolPartErrorBoundary>
    );
};

export default React.memo(ToolPart, (prev, next) => {
    return areRenderRelevantPartsEqual([prev.part], [next.part])
        && prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.alwaysShowActions === next.alwaysShowActions
        && prev.onContentChange === next.onContentChange
        && prev.onShowPopup === next.onShowPopup
        && prev.animateTailText === next.animateTailText;
});
