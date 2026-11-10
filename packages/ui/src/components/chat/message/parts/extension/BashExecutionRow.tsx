import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktopBridge';
import type { PiBashExecution, PiBashRecordedDetails } from '@/lib/pi/protocol';
import { cn } from '@/lib/utils';
import { abortShellCommand } from '@/sync/session-actions';
import {
    TOOL_NORMAL_ICON_STYLE,
    TOOL_ROW_DESCRIPTION_CLASS,
    TOOL_ROW_TITLE_CLASS,
} from '../toolPartStyles';

export type BashExecutionRowState =
    | { kind: 'recorded'; details: PiBashRecordedDetails }
    | { kind: 'live'; execution: PiBashExecution };

export interface BashExecutionRowProps {
    messageId: string;
    sessionId?: string;
    state: BashExecutionRowState;
    className?: string;
}

interface BashRowView {
    command: string;
    output: string;
    running: boolean;
    status: { text: string; tone: 'muted' | 'error' } | null;
    excludeFromContext: boolean;
    truncated: boolean;
    fullOutputPath?: string;
    note?: string;
}

const toView = (state: BashExecutionRowState): BashRowView => {
    if (state.kind === 'recorded') {
        const { details } = state;
        const exitCode = typeof details.exitCode === 'number' ? details.exitCode : undefined;
        return {
            command: details.command,
            output: details.output,
            running: false,
            status: details.cancelled
                ? { text: 'Cancelled', tone: 'muted' }
                : exitCode !== undefined && exitCode !== 0
                    ? { text: `Exit code ${exitCode}`, tone: 'error' }
                    : null,
            excludeFromContext: details.excludeFromContext === true,
            truncated: details.truncated === true,
            fullOutputPath: details.fullOutputPath,
        };
    }
    const { execution } = state;
    const exitCode = typeof execution.exitCode === 'number' ? execution.exitCode : undefined;
    const settled = execution.phase === 'completed' || execution.phase === 'cancelled';
    return {
        command: execution.command,
        output: execution.output ?? '',
        running: execution.phase === 'running',
        status: execution.phase === 'running'
            ? { text: 'Running', tone: 'muted' }
            : execution.phase === 'failed'
                ? { text: 'Failed', tone: 'error' }
                : execution.phase === 'cancelled'
                    ? { text: 'Cancelled', tone: 'muted' }
                    : exitCode !== undefined && exitCode !== 0
                        ? { text: `Exit code ${exitCode}`, tone: 'error' }
                        : null,
        excludeFromContext: execution.excludeFromContext === true,
        truncated: execution.truncated === true,
        fullOutputPath: execution.fullOutputPath,
        note: execution.phase === 'failed'
            ? execution.error
            : settled
                ? 'Added to the conversation when the current response ends.'
                : undefined,
    };
};

const OUTPUT_END_TOLERANCE_PX = 8;

/**
 * Transcript row for user shell commands (`!cmd`). The same row renders a
 * live execution and the recorded entry that replaces it, so the swap does
 * not change layout. Output is plain text: no markdown and no ANSI parsing,
 * because Pi records the raw bytes and a 64 KB tail can be large.
 */
export const BashExecutionRow: React.FC<BashExecutionRowProps> = ({
    messageId,
    sessionId,
    state,
    className,
}) => {
    const view = toView(state);
    const [stopping, setStopping] = React.useState(false);
    const showOutputPath = Boolean(view.fullOutputPath) && isDesktopShell() && isDesktopLocalOriginActive();

    // The output box keeps its newest lines in view, like a terminal, until
    // the user scrolls up inside it; scrolling back to the end resumes that.
    const outputRef = React.useRef<HTMLPreElement | null>(null);
    const stickToEndRef = React.useRef(true);
    const handleOutputScroll = React.useCallback(() => {
        const el = outputRef.current;
        if (!el) return;
        stickToEndRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= OUTPUT_END_TOLERANCE_PX;
    }, []);
    React.useLayoutEffect(() => {
        const el = outputRef.current;
        if (!el || !stickToEndRef.current) return;
        el.scrollTop = el.scrollHeight;
    }, [view.output]);

    const handleStop = React.useCallback(() => {
        if (!sessionId || stopping) return;
        setStopping(true);
        abortShellCommand(sessionId)
            .catch((error: unknown) => {
                toast.error(error instanceof Error && error.message ? error.message : 'Failed to stop the command');
            })
            .finally(() => setStopping(false));
    }, [sessionId, stopping]);

    return (
        <div className={cn('py-1', className)} data-bash-execution={messageId}>
            <div className="flex w-full min-w-0 items-center gap-x-1.5 py-1 pl-px pr-2">
                <span className="inline-flex h-5 shrink-0 items-center" style={TOOL_NORMAL_ICON_STYLE}>
                    <Icon name="terminal-box" className="size-3.5" aria-hidden="true" />
                </span>
                {/* The command is what the user typed, so it leads; "Shell" only names the row. */}
                <span className={cn(TOOL_ROW_TITLE_CLASS, 'shrink-0 font-normal')} style={{ color: 'var(--tools-description)' }}>
                    Shell
                </span>
                <span
                    className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'min-w-0 truncate text-foreground')}
                    title={view.command}
                >
                    {view.command}
                </span>
                {view.status ? (
                    view.status.tone === 'error' ? (
                        <span className="shrink-0 rounded border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-1.5 typography-micro font-medium text-[var(--status-error)]">
                            {view.status.text}
                        </span>
                    ) : (
                        <span className="shrink-0 typography-micro" style={{ color: 'var(--tools-description)' }}>
                            {view.status.text}
                        </span>
                    )
                ) : null}
                {view.truncated ? (
                    <span className="shrink-0 rounded border border-[var(--interactive-border)] px-1.5 typography-micro text-muted-foreground">Output truncated</span>
                ) : null}
                {view.excludeFromContext ? (
                    <span className="shrink-0 rounded border border-[var(--interactive-border)] px-1.5 typography-micro text-muted-foreground">Not sent to the model</span>
                ) : null}
                {view.running && sessionId ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={handleStop}
                        disabled={stopping}
                        aria-label="Stop the shell command"
                        className="ml-auto h-5 px-1.5 typography-micro font-medium normal-case text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                    >
                        Stop
                    </Button>
                ) : null}
            </div>

            {view.truncated ? (
                // Sits where the missing start would be, and says whether it can be found.
                <p className="mt-1 typography-micro text-muted-foreground text-pretty">
                    {showOutputPath ? (
                        <>
                            Earlier output was cut; the full output is in <span className="font-mono break-all select-text text-foreground">{view.fullOutputPath}</span>
                        </>
                    ) : (
                        'Earlier output was discarded. Only the last 50 KB is kept.'
                    )}
                </p>
            ) : null}

            {view.output.length > 0 ? (
                <pre
                    ref={outputRef}
                    onScroll={handleOutputScroll}
                    className="my-1 max-h-80 overflow-auto whitespace-pre rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-2 font-mono typography-code leading-relaxed"
                    data-no-drawer-swipe="true"
                >
                    {view.output}
                </pre>
            ) : null}

            {view.note ? (
                <p
                    className="typography-micro text-pretty"
                    style={{ color: state.kind === 'live' && state.execution.phase === 'failed' ? 'var(--status-error)' : 'var(--tools-description)' }}
                >
                    {view.note}
                </p>
            ) : null}
        </div>
    );
};
