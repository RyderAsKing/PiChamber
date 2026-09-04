import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Text } from '@/components/ui/text';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { ToolPart as ToolPartType } from '@/lib/chat/types';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import {
    getDirectoryForFilePath,
    getRelativeFilePath,
    isFilePathWithinDirectory,
    toAbsoluteFilePath,
} from '@/lib/path-utils';
import { openSkillSettings } from '@/lib/skills/openSkillSettings';
import { getToolMetadata } from '@/lib/toolHelpers';
import { getExternalFaviconUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import { areRenderRelevantActivityListsEqual } from '../renderCompare';
import { MinDurationShineText } from './MinDurationShineText';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import { getToolSkillName } from './skillToolPresentation';
import { TOOL_NORMAL_TITLE_STYLE, TOOL_ROW_DESCRIPTION_CLASS, TOOL_ROW_TITLE_CLASS } from './toolPartStyles';
import { getToolIcon } from './toolPresentation';

const ExternalLinkFavicon: React.FC<{ href: string }> = ({ href }) => {
    const [failed, setFailed] = React.useState(false);
    const faviconUrl = React.useMemo(() => getExternalFaviconUrl(href), [href]);

    if (!faviconUrl || failed) {
        return null;
    }

    return (
        <span className="inline-flex size-[18px] flex-shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--interactive-hover)]">
            <img
                src={faviconUrl}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="size-3.5 rounded-sm"
                onError={() => setFailed(true)}
            />
        </span>
    );
};

const isActivityRunning = (activity: TurnActivityPart): boolean => {
    if (activity.kind !== 'tool') return false;
    const part = activity.part as ToolPartType;
    const status = (part.state?.status as string) || undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    if (isFinalized) {
        return false;
    }
    if (status === 'running' || status === 'pending' || status === 'started') {
        return true;
    }
    return typeof activity.endedAt !== 'number';
};

const getActivityTime = (activity: TurnActivityPart): { start?: number; end?: number } => {
    const part = activity.part as ToolPartType;
    const stateTime = part.state?.time;
    return {
        start: typeof stateTime?.start === 'number' ? stateTime.start : undefined,
        end: typeof stateTime?.end === 'number' ? stateTime.end : activity.endedAt,
    };
};

const formatActivityDuration = (start: number, end?: number, now: number = Date.now()): string => {
    const seconds = Math.max(0, (end ?? now) - start) / 1000;
    const displaySeconds = seconds < 0.05 && typeof end === 'number' ? 0.1 : seconds;
    return `${displaySeconds.toFixed(1)}s`;
};

/**
 * Extract a short filename from a tool part's input (for aggregation display).
 */
const getToolFileName = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        const lastSlash = filePath.lastIndexOf('/');
        return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    }

    return null;
};

const getToolFilePath = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    return typeof filePath === 'string' && filePath.trim().length > 0 ? filePath : null;
};

const toTodoStatusKey = (value: unknown): 'pending' | 'in_progress' | 'completed' | 'cancelled' | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'pending') return 'pending';
    if (normalized === 'in_progress' || normalized === 'in progress' || normalized === 'inprogress') return 'in_progress';
    if (normalized === 'completed' || normalized === 'done') return 'completed';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
    return null;
};

const formatTodoSummary = (todos: unknown[]): string | null => {
    if (todos.length === 0) {
        return '0 tasks';
    }

    let pending = 0;
    let inProgress = 0;
    for (const todo of todos) {
        if (!todo || typeof todo !== 'object') {
            continue;
        }
        const status = toTodoStatusKey((todo as { status?: unknown }).status);
        if (!status) {
            continue;
        }
        if (status === 'pending') pending += 1;
        if (status === 'in_progress') inProgress += 1;
    }

    const activeCount = pending + inProgress;
    if (activeCount === 0) {
        return '0 tasks';
    }

    return `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'}`;
};

const getTodoSummaryFromActivity = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; output?: unknown } | undefined;
    const input = state?.input;
    const output = state?.output;

    if (Array.isArray(input?.todos)) {
        const summary = formatTodoSummary(input.todos);
        if (summary) return summary;
    }

    if (Array.isArray(output)) {
        const summary = formatTodoSummary(output);
        if (summary) return summary;
    }

    if (output && typeof output === 'object' && Array.isArray((output as { todos?: unknown }).todos)) {
        const summary = formatTodoSummary((output as { todos: unknown[] }).todos);
        if (summary) return summary;
    }

    if (typeof output === 'string' && output.trim().length > 0) {
        try {
            const parsed = JSON.parse(output) as unknown;
            if (Array.isArray(parsed)) {
                const summary = formatTodoSummary(parsed);
                if (summary) return summary;
            }
            if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { todos?: unknown }).todos)) {
                const summary = formatTodoSummary((parsed as { todos: unknown[] }).todos);
                if (summary) return summary;
            }
        } catch {
            // Ignore non-JSON output.
        }
    }

    return null;
};

const getToolReadOffset = (activity: TurnActivityPart): number | undefined => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const rawOffset =
        (typeof input?.offset === 'number' && Number.isFinite(input.offset) ? input.offset : undefined)
        ?? (typeof input?.line === 'number' && Number.isFinite(input.line) ? input.line : undefined)
        ?? (typeof metadata?.offset === 'number' && Number.isFinite(metadata.offset) ? metadata.offset : undefined)
        ?? (typeof metadata?.line === 'number' && Number.isFinite(metadata.line) ? metadata.line : undefined);

    if (typeof rawOffset !== 'number' || rawOffset <= 0) {
        return undefined;
    }

    return Math.floor(rawOffset);
};

const renderReadFilePath = (displayPath: string, animate = true) => {
    const lastSlash = displayPath.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <Text
                variant={animate ? 'generate-effect' : 'static'}
                className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                style={{ color: 'var(--tools-title)' }}
                title={displayPath}
            >
                {displayPath}
            </Text>
        );
    }

    const dir = displayPath.slice(0, lastSlash);
    const name = displayPath.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 inline-flex max-w-full flex-1 items-center overflow-hidden', TOOL_ROW_DESCRIPTION_CLASS)} title={displayPath}>
            {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
            <span
                className="min-w-0 shrink truncate whitespace-nowrap"
                style={{
                    color: 'var(--tools-description)',
                    direction: 'rtl',
                    textAlign: 'left',
                    unicodeBidi: 'plaintext',
                }}
            >
                {displayDir}
            </span>
            <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
            <Text
                variant={animate ? 'generate-effect' : 'static'}
                className="flex-shrink-0"
                style={{ color: 'var(--tools-title)' }}
            >
                {name}
            </Text>
        </span>
    );
};

/**
 * Get a short description for a static tool (for aggregation display).
 */
const getToolShortDescription = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const toolName = part.tool?.toLowerCase() ?? '';
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    // For search tools, show pattern
    if (toolName === 'grep' || toolName === 'search' || toolName === 'find' || toolName === 'ripgrep') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    // For glob, show pattern
    if (toolName === 'glob') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    // For web search tools, show query
    if (toolName === 'websearch' || toolName === 'web-search' || toolName === 'search_web' || toolName === 'codesearch' || toolName === 'perplexity') {
        const query = input?.query;
        if (typeof query === 'string' && query.trim().length > 0) {
            return query.length > 50 ? query.slice(0, 50) + '...' : query;
        }
    }

    // For skill, show name
    if (toolName === 'skill') {
        const name = input?.name;
        if (typeof name === 'string' && name.trim().length > 0) {
            return name;
        }
    }

    // For fetch-url tools, show URL
    if (toolName === 'webfetch' || toolName === 'fetch' || toolName === 'curl' || toolName === 'wget') {
        const url =
            (typeof input?.url === 'string' && input.url) ||
            (typeof input?.URL === 'string' && input.URL) ||
            (typeof metadata?.url === 'string' && metadata.url) ||
            (typeof metadata?.URL === 'string' && metadata.URL) ||
            '';

        if (typeof url === 'string' && url.trim().length > 0) {
            return url.trim();
        }
    }

    // For todo tools, show status summary without task names
    if (toolName === 'todowrite' || toolName === 'todoread') {
        return getTodoSummaryFromActivity(activity);
    }

    // Fallback: try filename
    return getToolFileName(activity);
};

const StaticToolRowInner: React.FC<{
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
}> = ({ toolName, activities, animateTailText }) => {
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const hasRunningActivity = React.useMemo(() => activities.some((activity) => isActivityRunning(activity)), [activities]);
    const timedActivity = React.useMemo(() => {
        for (const activity of activities) {
            const time = getActivityTime(activity);
            if (typeof time.start === 'number') {
                return { activity, time };
            }
        }
        return null;
    }, [activities]);
    const durationNow = useDurationTickerNow(
        Boolean(timedActivity && hasRunningActivity && typeof timedActivity.time.end !== 'number'),
        250,
    );
    const durationLabel = timedActivity
        ? formatActivityDuration(timedActivity.time.start!, timedActivity.time.end, durationNow)
        : null;

    const descriptions = React.useMemo(() => {
        const descs: string[] = [];
        for (const activity of activities) {
            const desc = getToolShortDescription(activity);
            if (desc && !descs.includes(desc)) {
                descs.push(desc);
            }
        }
        return descs;
    }, [activities]);

    const skillEntries = React.useMemo(() => {
        const entries: Array<{ name: string }> = [];
        for (const activity of activities) {
            const name = getToolSkillName(activity.part as ToolPartType);
            if (!name || entries.some((entry) => entry.name === name)) continue;
            entries.push({ name });
        }
        return entries;
    }, [activities]);

    const normalizedToolName = toolName.toLowerCase();
    const isSkillGroup = normalizedToolName === 'skill' || (normalizedToolName === 'read' && skillEntries.length > 0);
    const isReadGroup = normalizedToolName === 'read' && !isSkillGroup;
    const presentationToolName = isSkillGroup ? 'skill' : toolName;
    const displayName = getToolMetadata(presentationToolName).displayName;
    const icon = getToolIcon(presentationToolName);

    const readFileEntries = React.useMemo(() => {
        if (!isReadGroup) return [] as Array<{ path: string; displayPath: string; offset?: number }>;

        const entries: Array<{ path: string; displayPath: string; offset?: number }> = [];
        for (const activity of activities) {
            const filePath = getToolFilePath(activity);
            const offset = getToolReadOffset(activity);
            if (!filePath) continue;
            if (entries.some((entry) => entry.path === filePath)) continue;
            const displayPath = getRelativeFilePath(filePath, currentDirectory);
            if (!displayPath) continue;
            entries.push({ path: filePath, displayPath, offset });
        }
        return entries;
    }, [activities, currentDirectory, isReadGroup]);

    const handleFileClick = React.useCallback((filePath: string, offset?: number) => {
        const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
        if (!absolutePath) {
            return;
        }

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        // Dedicated mobile app: stage the same pending file focus/navigation
        // desktop uses, then surface the Files pane (workspace drawer tab),
        // which consumes it. Desktop grant flows don't apply here.
        if (mobileActions) {
            const uiStore = useUIStore.getState();
            const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
            if (offset && Number.isFinite(offset)) {
                uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            } else {
                uiStore.openContextFile(contextDirectory, absolutePath);
            }
            mobileActions.openFiles();
            return;
        }

        if (!isFilePathWithinDirectory(absolutePath, currentDirectory)) {
            void ensureOutsideFileGrantForDesktop(absolutePath, currentDirectory).then(() => {
                const uiStore = useUIStore.getState();
                const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
                if (offset && Number.isFinite(offset)) {
                    uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
                    return;
                }
                uiStore.openContextFile(contextDirectory, absolutePath);
            });
            return;
        }

        const uiStore = useUIStore.getState();
        const contextDirectory = getDirectoryForFilePath(currentDirectory, absolutePath);
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            return;
        }
        uiStore.openContextFile(contextDirectory, absolutePath);
    }, [currentDirectory, mobileActions, runtime]);

    const isSearchGroup = normalizedToolName === 'grep'
        || normalizedToolName === 'search'
        || normalizedToolName === 'find'
        || normalizedToolName === 'ripgrep'
        || normalizedToolName === 'glob';
    const isFetchGroup = normalizedToolName === 'webfetch' || normalizedToolName === 'fetch' || normalizedToolName === 'curl' || normalizedToolName === 'wget';

    return (
        <div
            // oc-static-tool-row: on touch devices mobile.css raises this to the
            // same 36px floor the [role="button"] expandable/reasoning rows get,
            // so static and expandable rows have identical rhythm.
            className={cn(
                'oc-static-tool-row flex w-full items-center gap-x-1.5 pr-2 pl-px py-1 min-w-0'
            )}
        >
            <div className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                {icon}
            </div>
            <MinDurationShineText
                active={hasRunningActivity}
                minDurationMs={1000}
                className={cn(TOOL_ROW_TITLE_CLASS, 'inline-flex items-center flex-shrink-0')}
                style={TOOL_NORMAL_TITLE_STYLE}
                title={displayName}
            >
                {displayName}
            </MinDurationShineText>
            {isReadGroup && readFileEntries.length > 0
                ? readFileEntries.map((entry) => (
                    <button
                        key={entry.path}
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleFileClick(entry.path, entry.offset);
                        }}
                        className={cn('inline-flex !min-h-0 items-center justify-start gap-1 min-w-0 flex-1 text-left hover:text-[var(--status-info)] hover:opacity-90', TOOL_ROW_DESCRIPTION_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                        title={entry.offset ? `${entry.displayPath}:${entry.offset}` : entry.displayPath}
                    >
                        {showToolFileIcons ? <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" /> : null}
                        {renderReadFilePath(entry.displayPath, animateTailText)}
                    </button>
                ))
                : null}
            {isSearchGroup && descriptions.length > 0
                ? descriptions.map((desc, index) => (
                    <span key={`${desc}-${index}`} className="inline-flex min-w-0 flex-1">
                        <Text
                            variant={animateTailText ? 'generate-effect' : 'static'}
                            className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                            style={{ color: 'var(--tools-description)' }}
                            title={desc}
                        >
                            "{desc}"
                        </Text>
                    </span>
                ))
                : null}
            {isFetchGroup && descriptions.length > 0
                ? descriptions.map((url, index) => (
                    <a
                        key={`${url}-${index}`}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            'min-w-0 flex-1 inline-flex items-center gap-1.5 underline decoration-[color:var(--status-info)] underline-offset-2 hover:opacity-90',
                            'truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS
                        )}
                        style={{ color: 'var(--status-info)' }}
                        title={url}
                    >
                        <ExternalLinkFavicon href={url} />
                        <span className="min-w-0 truncate">{url}</span>
                    </a>
                ))
                : null}
            {isSkillGroup && skillEntries.length > 0
                ? skillEntries.map((entry, index) => (
                    <button
                        key={`${entry.name}-${index}`}
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            openSkillSettings(entry.name, mobileActions);
                        }}
                        className={cn('inline-flex !min-h-0 h-5 min-w-0 flex-1 items-center truncate whitespace-nowrap text-left hover:opacity-90', TOOL_ROW_DESCRIPTION_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                        title={`Open ${entry.name} in Settings`}
                        aria-label={`Open ${entry.name} skill in Settings`}
                    >
                        {entry.name}
                    </button>
                ))
                : null}
            {!isReadGroup && !isSearchGroup && !isFetchGroup && !isSkillGroup && descriptions.length > 0 ? (
                <Text
                    variant={animateTailText ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                >
                    {descriptions.join(' ')}
                </Text>
            ) : null}
            {durationLabel ? (
                <span
                    className={cn('flex-shrink-0 tabular-nums text-muted-foreground/80', TOOL_ROW_DESCRIPTION_CLASS)}
                    aria-label="Tool duration"
                >
                    {durationLabel}
                </span>
            ) : null}
        </div>
    );
};

export const StaticToolRow = React.memo(StaticToolRowInner, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
        && areRenderRelevantActivityListsEqual(prev.activities, next.activities);
});
