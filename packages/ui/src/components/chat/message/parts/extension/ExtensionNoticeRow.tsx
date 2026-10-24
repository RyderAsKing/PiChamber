import * as React from 'react';

import { AnsiText } from '@/components/chat/AnsiText';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
    TOOL_NORMAL_TITLE_STYLE,
    TOOL_ROW_DESCRIPTION_CLASS,
    TOOL_ROW_TITLE_CLASS,
} from '../toolPartStyles';

export type ExtensionNoticeLevel = 'info' | 'warning' | 'error';

export interface ExtensionNoticeRowProps {
    messageId: string;
    level: ExtensionNoticeLevel;
    message: string;
    className?: string;
}

/** Notices longer than this render behind a Show more toggle. */
const NOTICE_CLAMPED_LINES = 12;

const NOTICE_META: Record<ExtensionNoticeLevel, { label: string; icon: IconName }> = {
    info: { label: 'Notice', icon: 'information' },
    warning: { label: 'Warning', icon: 'alert' },
    error: { label: 'Error', icon: 'error-warning' },
};

/**
 * Transcript row for live extension notices (`ctx.ui.notify`). It reads like
 * the surrounding tool rows: a tool-row style header (level icon, "Notice" /
 * "Warning" / "Error") and the message body as mono lines, one `AnsiText`
 * per line so ANSI colors survive while empty lines keep their height.
 *
 * The body is visible by default. Warnings and errors mark the header with
 * status tokens; info stays muted. Notices are live-only and never saved to
 * the session file.
 */
export const ExtensionNoticeRow: React.FC<ExtensionNoticeRowProps> = ({
    messageId,
    level,
    message,
    className,
}) => {
    const [isExpanded, setIsExpanded] = React.useState(false);

    const meta = NOTICE_META[level] ?? NOTICE_META.info;
    const body = typeof message === 'string' && message.trim().length > 0
        ? message
        : 'Extension notification';
    const lines = body.split('\n');
    const isClamped = lines.length > NOTICE_CLAMPED_LINES;
    const visibleLines = !isClamped || isExpanded ? lines : lines.slice(0, NOTICE_CLAMPED_LINES);

    const iconStyle = level === 'error'
        ? { color: 'var(--status-error)' }
        : level === 'warning'
            ? { color: 'var(--status-warning)' }
            : { color: 'var(--tools-icon)' };
    const labelStyle = level === 'error'
        ? { color: 'var(--status-error)' }
        : level === 'warning'
            ? { color: 'var(--status-warning)' }
            : TOOL_NORMAL_TITLE_STYLE;

    return (
        <div className={cn('py-1', className)} data-extension-notice={messageId}>
            <div className="flex w-full min-w-0 items-center gap-x-1.5 py-1 pl-px pr-2">
                <span className="inline-flex h-5 shrink-0 items-center" style={iconStyle}>
                    <Icon name={meta.icon} className="size-3.5" aria-hidden="true" />
                </span>
                <span className={cn(TOOL_ROW_TITLE_CLASS, 'shrink-0')} style={labelStyle}>
                    {meta.label}
                </span>
                <span
                    className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'min-w-0 truncate')}
                    style={{ color: 'var(--tools-description)' }}
                    title="Extension notice"
                >
                    Extension
                </span>
            </div>

            <div
                className="my-1 max-h-80 overflow-x-auto overflow-y-auto whitespace-pre rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-2 font-mono typography-micro"
                data-extension-notice-body="true"
            >
                {visibleLines.map((line, index) => (
                    <div key={index} className="min-h-[1.25em] leading-relaxed w-max min-w-full">
                        <AnsiText text={line} />
                    </div>
                ))}
            </div>

            {isClamped && (
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setIsExpanded((expanded) => !expanded)}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? 'Show less of the extension notice' : 'Show more of the extension notice'}
                    className="h-5 gap-1 px-1.5 typography-micro font-medium normal-case text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                >
                    <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3" />
                    <span>{isExpanded ? 'Show less' : 'Show more'}</span>
                </Button>
            )}
        </div>
    );
};
