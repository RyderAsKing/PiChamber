import React from 'react';

import { Text } from '@/components/ui/text';
import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getToolMetadata } from '@/lib/toolHelpers';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import type { ToolPopupContent } from '../types';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { getToolIcon } from './toolPresentation';
import { normalizeToolName } from './toolRenderUtils';
import {
    TOOL_NORMAL_TITLE_STYLE,
    TOOL_ROW_DESCRIPTION_CLASS,
    TOOL_ROW_TITLE_CLASS,
} from './toolPartStyles';
import {
    getTaskSummaryEntryRenderSignature,
    getTaskSummaryLabel,
    stripTaskMetadataFromOutput,
    type TaskToolSummaryEntry,
} from './taskToolModel';
import { AnimatedToolPath, ToolScrollableSection } from './ToolPartChrome';

const FILE_PATH_LABEL_TOOLS = new Set([
    'read',
    'view',
    'file_read',
    'cat',
    'write',
    'create',
    'file_write',
    'edit',
    'multiedit',
    'apply_patch',
]);

const shouldRenderGitPathLabel = (toolName: string, label: string): boolean => {
    if (!FILE_PATH_LABEL_TOOLS.has(toolName.toLowerCase())) {
        return false;
    }

    const trimmed = label.trim();
    if (!trimmed || trimmed === 'Patch' || /^\d+\s+files$/.test(trimmed)) {
        return false;
    }

    if (trimmed.includes('/') || trimmed.includes('\\')) {
        return true;
    }

    const baseName = trimmed.split(/[\\/]/).pop() || trimmed;
    if (baseName.startsWith('.') || baseName.includes('.')) {
        return true;
    }

    return /^[A-Za-z0-9_-]+$/.test(baseName);
};

const areTaskSummaryEntriesRenderEqual = (
    prevEntries: TaskToolSummaryEntry[],
    nextEntries: TaskToolSummaryEntry[],
): boolean => {
    if (prevEntries === nextEntries) return true;
    if (prevEntries.length !== nextEntries.length) return false;
    for (let index = 0; index < prevEntries.length; index += 1) {
        if (getTaskSummaryEntryRenderSignature(prevEntries[index]) !== getTaskSummaryEntryRenderSignature(nextEntries[index])) {
            return false;
        }
    }
    return true;
};

const TaskSummaryEntryRow = React.memo(({
    entry,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entry: TaskToolSummaryEntry;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const normalizedToolName = normalizeToolName(entry.tool);
    const toolName = normalizedToolName.length > 0 ? normalizedToolName : 'tool';
    const label = getTaskSummaryLabel(entry);
    const hasLabel = label.trim().length > 0;
    const status = entry.state?.status;
    const displayName = getToolMetadata(toolName).displayName;

    return (
        <ToolRevealOnMount animate={animateTailText}>
            {/* Single-line rows everywhere: the old mobile break-words mode
                wrapped long shell commands into a hanging column and floated
                the icon to the top of the block. Errors still wrap — they must
                stay readable. */}
            <div className={cn('flex gap-2 min-w-0 w-full', status === 'error' && isMobile ? 'items-start' : 'items-center')}>
                <span className="flex-shrink-0 text-foreground/80">{getToolIcon(toolName)}</span>
                <span
                    className={cn(TOOL_ROW_TITLE_CLASS, 'text-foreground/80 flex-shrink-0')}
                    style={TOOL_NORMAL_TITLE_STYLE}
                    title={displayName}
                >
                    {displayName}
                </span>
                {hasLabel ? (
                    status !== 'error' && shouldRenderGitPathLabel(toolName, label) ? (
                        <AnimatedToolPath path={label} animate={animateTailText} showFileIcons={showToolFileIcons} />
                    ) : (
                        status === 'error' ? (
                            <span className={cn(
                                TOOL_ROW_DESCRIPTION_CLASS,
                                'flex-1 min-w-0 text-[var(--status-error)]',
                                isMobile ? 'whitespace-normal break-words' : 'truncate',
                            )}>
                                {label}
                            </span>
                        ) : (
                            <Text
                                variant={animateTailText ? 'generate-effect' : 'static'}
                                className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'flex-1 min-w-0 truncate text-muted-foreground/70')}
                                style={{ color: 'var(--tools-description)' }}
                                title={label}
                            >
                                {label}
                            </Text>
                        )
                    )
                ) : null}
            </div>
        </ToolRevealOnMount>
    );
}, (prev, next) => {
    return prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && getTaskSummaryEntryRenderSignature(prev.entry) === getTaskSummaryEntryRenderSignature(next.entry);
});

TaskSummaryEntryRow.displayName = 'TaskSummaryEntryRow';

const TaskSummaryEntriesList = React.memo(({
    entries,
    isExpanded,
    isMobile,
    animateTailText,
    showToolFileIcons,
}: {
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    animateTailText: boolean;
    showToolFileIcons: boolean;
}) => {
    const visibleEntries = isExpanded ? entries : entries.slice(-6);
    const hiddenCount = Math.max(0, entries.length - visibleEntries.length);
    const visibleStartIndex = entries.length - visibleEntries.length;

    return (
        <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-[min(17.5rem,45vh)]'} disableHorizontal>
            <div className="w-full min-w-0 space-y-1">
                {hiddenCount > 0 ? (
                    <div className="typography-micro text-muted-foreground/70">+{hiddenCount} more…</div>
                ) : null}

                {visibleEntries.map((entry, idx) => {
                    const absoluteIndex = isExpanded ? idx : visibleStartIndex + idx;
                    const rowKey = entry.id ?? `${getTaskSummaryEntryRenderSignature(entry)}:${absoluteIndex}`;
                    return (
                        <TaskSummaryEntryRow
                            key={rowKey}
                            entry={entry}
                            isMobile={isMobile}
                            animateTailText={animateTailText}
                            showToolFileIcons={showToolFileIcons}
                        />
                    );
                })}
            </div>
        </ToolScrollableSection>
    );
}, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.animateTailText === next.animateTailText
        && prev.showToolFileIcons === next.showToolFileIcons
        && areTaskSummaryEntriesRenderEqual(prev.entries, next.entries);
});

TaskSummaryEntriesList.displayName = 'TaskSummaryEntriesList';

export const TaskToolSummary: React.FC<{
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    output?: string;
    sessionId?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    input?: Record<string, unknown>;
    animateTailText?: boolean;
    isActive?: boolean;
}> = ({ entries, isExpanded, isMobile, output, sessionId, onShowPopup, input, animateTailText = true, isActive = false }) => {
    const currentDirectory = useEffectiveDirectory();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const trimmedOutput = typeof output === 'string'
        ? stripTaskMetadataFromOutput(output)
        : '';
    const hasOutput = trimmedOutput.length > 0;
    const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);

    const handleOpenSession = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (sessionId && currentDirectory) {
            setCurrentSession(sessionId, currentDirectory);
        }
    };

    const agentType = typeof input?.subagent_type === 'string'
        ? input.subagent_type
        : 'subagent';

    if (entries.length === 0 && !hasOutput && !sessionId) {
        return (
            <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]">
                <div className="typography-meta text-muted-foreground/70">
                    {isActive ? 'Waiting for subagent activity...' : 'No subagent session id on task metadata.'}
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]',
                'before:absolute before:left-[0.4375rem] before:w-px before:bg-[var(--tools-border)] before:content-[""]',
                'before:top-[-0.25rem] before:bottom-0'
            )}
        >
            {entries.length > 0 ? (
                <TaskSummaryEntriesList
                    entries={entries}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    animateTailText={animateTailText}
                    showToolFileIcons={showToolFileIcons}
                />
            ) : null}

            {sessionId && (
                <button
                    type="button"
                    className="flex items-center gap-2 typography-meta text-primary hover:text-primary/80 w-full"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handleOpenSession}
                >
                    <Icon name="external-link" className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="typography-meta text-primary font-medium">{`Open ${agentType.charAt(0).toUpperCase() + agentType.slice(1)} subtask`}</span>
                </button>
            )}

            {hasOutput ? (
                <div className={cn('space-y-1', (entries.length > 0 || sessionId) && 'pt-1')}
                >
                    <button
                        type="button"
                        className="flex items-center gap-2 typography-meta text-foreground/80 hover:text-foreground w-full"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsOutputExpanded((prev) => !prev);
                        }}
                    >
                        {isOutputExpanded ? (
                            <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0" />
                        ) : (
                            <Icon name="arrow-right-s" className="h-3.5 w-3.5 flex-shrink-0" />
                        )}
                        <span className="typography-meta text-foreground/80 font-medium">{"Output"}</span>
                    </button>
                    {isOutputExpanded ? (
                        <ToolScrollableSection maxHeightClass="max-h-[50vh]">
                            <div className="w-full min-w-0">
                                <SimpleMarkdownRenderer content={trimmedOutput} variant="tool" onShowPopup={onShowPopup} />
                            </div>
                        </ToolScrollableSection>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
