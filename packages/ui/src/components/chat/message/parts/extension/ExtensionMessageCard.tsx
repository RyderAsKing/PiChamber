import * as React from 'react';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { parseExtensionChatItem } from '@/lib/pi/extension-ui';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '../../../MarkdownRenderer';

interface ExtensionMessageCardProps {
    sessionId?: string;
    messageId: string;
    customType?: string;
    text?: string;
    data?: unknown;
    details?: unknown;
    className?: string;
}

const toneClasses: Record<string, string> = {
    info: 'bg-status-info/15 text-status-info',
    success: 'bg-status-success/15 text-status-success',
    warning: 'bg-status-warning/15 text-status-warning',
    error: 'bg-status-error/15 text-status-error',
    neutral: 'bg-interactive-hover text-muted-foreground',
};

interface ActionButtonProps {
    label: string;
    variant: 'default' | 'outline' | 'ghost';
    command: string;
    args?: string;
    sessionId?: string;
}

const ExtensionActionButton: React.FC<ActionButtonProps> = ({ label, variant, command, args, sessionId }) => {
    const [pending, setPending] = React.useState(false);
    const handleClick = React.useCallback(async () => {
        if (!sessionId || pending) return;
        setPending(true);
        try {
            const text = args && args.trim().length > 0 ? `/${command} ${args.trim()}` : `/${command}`;
            await getPiSessionStore().prompt(sessionId, text, 'prompt');
        } finally {
            setPending(false);
        }
    }, [sessionId, pending, command, args]);

    if (!sessionId) return null;

    return (
        <Button
            size="xs"
            variant={variant}
            onClick={handleClick}
            disabled={pending}
            aria-label={label}
        >
            {label}
        </Button>
    );
};

const ExtensionProgress: React.FC<{ label?: string; value: number; max: number }> = ({ label, value, max }) => {
    const clamped = Math.min(Math.max(value, 0), max);
    const percent = Math.round((clamped / max) * 100);
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-muted-foreground">{label ?? ''}</span>
                <span className="tabular-nums text-muted-foreground">{percent}%</span>
            </div>
            <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-interactive-hover"
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={label ?? 'Progress'}
            >
                <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${percent}%` }}
                />
            </div>
        </div>
    );
};

export const ExtensionMessageCard: React.FC<ExtensionMessageCardProps> = ({
    sessionId,
    messageId,
    customType,
    text,
    data,
    details,
    className,
}) => {
    const parsed = React.useMemo(
        () => parseExtensionChatItem({ customType, data, details, text }),
        [customType, data, details, text],
    );

    const title = parsed.kind === 'ui' ? parsed.descriptor.title : parsed.title;
    const actions = parsed.kind === 'ui' ? parsed.descriptor.actions : undefined;
    const component = parsed.kind === 'ui' ? parsed.descriptor.component : undefined;

    const body = () => {
        if (!component) {
            // Generic fallback: extension-authored content without a PiChamber
            // GUI descriptor renders as preformatted text so nothing is lost.
            return (
                <pre className="max-h-64 overflow-auto rounded-md bg-surface-inset p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {parsed.kind === 'fallback' ? parsed.body : ''}
                </pre>
            );
        }
        switch (component.component) {
            case 'markdown':
                return (
                    <MarkdownRenderer
                        messageId={messageId}
                        content={component.body}
                        className="text-sm"
                    />
                );
            case 'kv':
                return (
                    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1.5 text-sm">
                        {component.rows.map((row) => (
                            <React.Fragment key={`${row.label}:${row.value}`}>
                                <dt className="truncate text-muted-foreground">{row.label}</dt>
                                <dd className={cn('break-words', toneClasses[row.tone ?? 'neutral']?.split(' ')[1])}>
                                    {row.value}
                                </dd>
                            </React.Fragment>
                        ))}
                    </dl>
                );
            case 'list':
                return (
                    <ul className="flex flex-col gap-1.5 text-sm">
                        {component.items.map((item) => (
                            <li key={`${item.label}:${item.value}`} className="flex items-baseline gap-2">
                                <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-interactive-hover" />
                                <span className="font-medium">{item.label}</span>
                                {item.value && <span className="text-muted-foreground">{item.value}</span>}
                            </li>
                        ))}
                    </ul>
                );
            case 'table':
                return (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr>
                                    {component.columns.map((column) => (
                                        <th key={column} className="border-b px-2 py-1.5 text-left font-medium text-muted-foreground">
                                            {column}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {component.rows.map((row, rowIndex) => (
                                    <tr key={rowIndex}>
                                        {row.map((cell, cellIndex) => (
                                            <td key={cellIndex} className="border-b px-2 py-1.5 break-words">
                                                {cell}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                );
            case 'progress': {
                const max = component.max ?? 100;
                return <ExtensionProgress label={component.label} value={component.value} max={max > 0 ? max : 100} />;
            }
            case 'badges':
                return (
                    <div className="flex flex-wrap gap-1.5">
                        {component.items.map((item) => (
                            <span
                                key={item.label}
                                className={cn(
                                    'rounded-full px-2 py-0.5 text-xs font-medium',
                                    toneClasses[item.tone ?? 'neutral'],
                                )}
                            >
                                {item.label}
                            </span>
                        ))}
                    </div>
                );
            case 'code':
                return (
                    <pre className="max-h-80 overflow-auto rounded-md bg-surface-inset p-2 font-mono text-xs leading-relaxed">
                        <code>{component.code}</code>
                    </pre>
                );
            default:
                return null;
        }
    };

    return (
        <div
            className={cn(
                'my-1 flex flex-col gap-2 rounded-xl border bg-card p-3 text-card-foreground',
                className,
            )}
            data-extension-ui={messageId}
        >
            {(title !== undefined || actions !== undefined) && (
                <div className="flex items-center justify-between gap-2">
                    {title !== undefined && (
                        <div className="flex min-w-0 items-center gap-1.5">
                            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                                {title}
                            </span>
                        </div>
                    )}
                    {actions !== undefined && (
                        <div className="flex shrink-0 flex-wrap gap-1.5">
                            {actions.map((action) => (
                                <ExtensionActionButton
                                    key={`${action.command}:${action.label}`}
                                    label={action.label}
                                    variant={action.variant ?? 'outline'}
                                    command={action.command}
                                    args={action.args}
                                    sessionId={sessionId}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}
            {body()}
        </div>
    );
};
