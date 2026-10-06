import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { Icon } from '@/components/icon/Icon';
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
    className?: string;
}

/**
 * Transcript row for extension-authored messages (`pi.sendMessage`) and
 * unrecognized extension payloads. It reads like the surrounding chat rather
 * than a card: a tool-row style header (plug icon, "Extension", the raw
 * customType in mono), the message text as assistant prose, and the optional
 * `details` payload behind the header's disclosure as a structured summary.
 */
export const ExtensionNoteRow: React.FC<ExtensionNoteRowProps> = ({
    messageId,
    customType,
    text,
    data,
    details,
    className,
}) => {
    const { t } = useTranslation();
    const [isDetailsOpen, setIsDetailsOpen] = React.useState(false);

    const payload = details !== undefined ? details : data;
    const hasPayload = payload !== undefined && payload !== null;
    const hasText = typeof text === 'string' && text.trim().length > 0;
    const typeLabel = customType || 'extension';

    const header = (
        <>
            <span className="inline-flex h-5 shrink-0 items-center" style={{ color: 'var(--tools-icon)' }}>
                <Icon name="plug-2" className="size-3.5" aria-hidden="true" />
            </span>
            <span className={cn(TOOL_ROW_TITLE_CLASS, 'shrink-0')} style={TOOL_NORMAL_TITLE_STYLE}>
                {t('Extension')}
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
            {hasPayload ? (
                <button
                    type="button"
                    onClick={() => setIsDetailsOpen((open) => !open)}
                    aria-expanded={isDetailsOpen}
                    aria-label={isDetailsOpen ? t('Hide {{label}} details', { label: typeLabel }) : t('Show {{label}} details', { label: typeLabel })}
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

            {hasPayload && isDetailsOpen && (
                <div className="relative mb-1 ml-2 pl-3">
                    <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 top-0 w-px bg-[var(--tools-border)]" />
                    <div className="max-h-80 overflow-auto">
                        <JsonSummaryView data={payload} />
                    </div>
                </div>
            )}

            {hasText && (
                <div className="w-full min-w-0 break-words pb-1 pt-1">
                    <MarkdownRenderer messageId={messageId} content={text} variant="assistant" />
                </div>
            )}
        </div>
    );
};
