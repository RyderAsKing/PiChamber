import * as React from 'react';

import { AnsiText } from '@/components/chat/AnsiText';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { PiExtensionMessageRender } from '@/lib/pi/types';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '../../../MarkdownRenderer';
import { JsonSummaryView } from '../JsonSummaryView';
import {
    TOOL_NORMAL_TITLE_STYLE,
    TOOL_ROW_DESCRIPTION_CLASS,
    TOOL_ROW_TITLE_CLASS,
} from '../toolPartStyles';

export interface ExtensionNoteRowProps {
    messageId: string;
    customType?: string;
    text?: string;
    data?: unknown;
    details?: unknown;
    render?: PiExtensionMessageRender;
    className?: string;
}

/**
 * Transcript row for extension-authored messages (`pi.sendMessage`) and
 * unrecognized extension payloads. It reads like the surrounding chat rather
 * than a card: a tool-row style header (plug icon, "Extension", the raw
 * customType in mono), the message text as assistant prose, and the optional
 * `details` payload behind the header's disclosure as a structured summary.
 *
 * Messages with a daemon-rendered message render (`registerMessageRenderer`)
 * instead show the ANSI render lines as the main body (same mono treatment
 * as extension tool renders), an optional Show more/less toggle for the
 * expanded lines, and the raw text plus `details` payload behind a
 * collapsed-by-default "Raw message" disclosure.
 */
export const ExtensionNoteRow: React.FC<ExtensionNoteRowProps> = ({
    messageId,
    customType,
    text,
    data,
    details,
    render,
    className,
}) => {
    const [isDetailsOpen, setIsDetailsOpen] = React.useState(false);
    const [isRenderExpanded, setIsRenderExpanded] = React.useState(false);
    const [isRawOpen, setIsRawOpen] = React.useState(false);

    const payload = details !== undefined ? details : data;
    const hasPayload = payload !== undefined && payload !== null;
    const hasText = typeof text === 'string' && text.trim().length > 0;
    const typeLabel = customType || 'extension';

    const renderLines = Array.isArray(render?.message) && render.message.length > 0
        ? render.message
        : undefined;
    const expandedLines = Array.isArray(render?.messageExpanded) && render.messageExpanded.length > 0
        ? render.messageExpanded
        : undefined;
    const visibleRenderLines = isRenderExpanded && expandedLines ? expandedLines : renderLines;

    const header = (
        <>
            <span className="inline-flex h-5 shrink-0 items-center" style={{ color: 'var(--tools-icon)' }}>
                <Icon name="plug-2" className="size-3.5" aria-hidden="true" />
            </span>
            <span className={cn(TOOL_ROW_TITLE_CLASS, 'shrink-0')} style={TOOL_NORMAL_TITLE_STYLE}>
                Extension
            </span>
            <span
                className={cn(TOOL_ROW_DESCRIPTION_CLASS, 'min-w-0 truncate')}
                style={{ color: 'var(--tools-description)' }}
                title={typeLabel}
            >
                {typeLabel}
            </span>
        </>
    );

    return (
        <div className={cn('py-1', className)} data-extension-ui={messageId}>
            {hasPayload && !renderLines ? (
                <button
                    type="button"
                    onClick={() => setIsDetailsOpen((open) => !open)}
                    aria-expanded={isDetailsOpen}
                    aria-label={isDetailsOpen ? `Hide ${typeLabel} details` : `Show ${typeLabel} details`}
                    className="group/extension-note flex w-full min-w-0 items-center gap-x-1.5 py-1 pl-px pr-2 text-left"
                >
                    {header}
                    <Icon
                        name="arrow-right-s"
                        aria-hidden="true"
                        className={cn(
                            'size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] duration-150 group-hover/extension-note:opacity-100 group-focus-visible/extension-note:opacity-100',
                            isDetailsOpen && 'rotate-90 opacity-100',
                        )}
                    />
                </button>
            ) : (
                <div className="flex w-full min-w-0 items-center gap-x-1.5 py-1 pl-px pr-2">{header}</div>
            )}

            {hasPayload && isDetailsOpen && !renderLines && (
                <div className="relative mb-1 ml-2 pl-3">
                    <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 top-0 w-px bg-[var(--tools-border)]" />
                    <div className="max-h-80 overflow-auto">
                        <JsonSummaryView data={payload} />
                    </div>
                </div>
            )}

            {visibleRenderLines && (
                <div
                    className="my-1 max-h-80 overflow-x-auto overflow-y-auto whitespace-pre rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-2 font-mono typography-micro"
                    data-extension-message-render="true"
                >
                    {visibleRenderLines.map((line, index) => (
                        <div key={index} className="min-h-[1.25em] leading-relaxed">
                            <AnsiText text={line} />
                        </div>
                    ))}
                </div>
            )}

            {renderLines && expandedLines && (
                <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setIsRenderExpanded((expanded) => !expanded)}
                    aria-expanded={isRenderExpanded}
                    className="h-5 gap-1 px-1.5 typography-micro font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                >
                    <Icon name={isRenderExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3" />
                    <span>{isRenderExpanded ? 'Show less' : 'Show more'}</span>
                </Button>
            )}

            {renderLines && (hasText || hasPayload) && (
                <div>
                    <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setIsRawOpen((open) => !open)}
                        aria-expanded={isRawOpen}
                        className="h-5 gap-1 px-1.5 typography-micro font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                    >
                        <Icon name={isRawOpen ? 'arrow-down-s' : 'arrow-right-s'} className="size-3" />
                        <span>Raw message</span>
                    </Button>
                    {isRawOpen && (
                        <div className="relative mb-1 ml-2 pl-3">
                            <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 top-0 w-px bg-[var(--tools-border)]" />
                            {hasText && (
                                <div className="w-full min-w-0 break-words pb-1 pt-1">
                                    <MarkdownRenderer messageId={messageId} content={text} variant="assistant" />
                                </div>
                            )}
                            {hasPayload && (
                                <div className="max-h-80 overflow-auto">
                                    <JsonSummaryView data={payload} />
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {!renderLines && hasText && (
                <div className="w-full min-w-0 break-words pb-1 pt-1">
                    <MarkdownRenderer messageId={messageId} content={text} variant="assistant" />
                </div>
            )}
        </div>
    );
};
