import * as React from 'react';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { normalizeExtensionCommandArgs, parseExtensionChatItem } from '@/lib/pi/extension-ui';
import type { ExtensionUiAction } from '@/lib/pi/extension-ui';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { iconSpriteData } from '@/components/icon/sprite';
import type { IconName } from '@/components/icon/icons';
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
    action: ExtensionUiAction;
    variant: 'default' | 'outline' | 'ghost';
    sessionId?: string;
}

const isKnownIcon = (name: string | undefined): name is IconName => (
    typeof name === 'string' && name.length > 0 && name in iconSpriteData
);

const ExtensionActionButton: React.FC<ActionButtonProps> = ({ action, variant, sessionId }) => {
    const [pending, setPending] = React.useState(false);
    const [confirming, setConfirming] = React.useState(false);
    const [prompting, setPrompting] = React.useState(false);
    const [promptValue, setPromptValue] = React.useState('');

    const runCommand = React.useCallback(async (args?: string) => {
        if (!sessionId || pending) return;
        setPending(true);
        try {
            const normalizedArgs = normalizeExtensionCommandArgs(args);
            const text = normalizedArgs ? `/${action.command} ${normalizedArgs}` : `/${action.command}`;
            await getPiSessionStore().prompt(sessionId, text, 'prompt');
        } finally {
            setPending(false);
        }
    }, [sessionId, pending, action.command]);

    const runAction = React.useCallback(async () => {
        if (action.promptForArgs) {
            setPrompting(true);
            setPromptValue('');
            return;
        }
        await runCommand(action.args);
    }, [action, runCommand]);

    const handleClick = React.useCallback(async () => {
        if (!sessionId || pending || action.disabled) return;
        if (action.confirm) {
            setConfirming(true);
            return;
        }
        await runAction();
    }, [sessionId, pending, action, runAction]);

    if (!sessionId) return null;

    const busy = pending || action.loading === true;
    const icon = isKnownIcon(action.icon) ? <Icon name={action.icon} className="size-3.5" /> : null;

    if (confirming) {
        return (
            <div role="alertdialog" aria-label={action.confirm} className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">{action.confirm}</span>
                <Button
                    type="button"
                    size="xs"
                    variant="default"
                    onClick={() => {
                        setConfirming(false);
                        void runAction();
                    }}
                >
                    Continue
                </Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
        );
    }

    if (prompting) {
        return (
            <form
                className="flex min-w-0 flex-wrap items-center gap-1.5"
                onSubmit={(event) => {
                    event.preventDefault();
                    setPrompting(false);
                    void runCommand(promptValue);
                }}
            >
                <input
                    autoFocus
                    value={promptValue}
                    onChange={(event) => setPromptValue(event.target.value)}
                    placeholder={action.promptForArgs?.placeholder ?? ''}
                    aria-label={action.promptForArgs?.label ?? action.label}
                    className="h-6 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus sm:w-40 sm:flex-none"
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            setPrompting(false);
                        }
                    }}
                />
                <Button type="submit" size="xs" variant="default" disabled={pending}>Run</Button>
                <Button type="button" size="xs" variant="ghost" onClick={() => setPrompting(false)}>Cancel</Button>
            </form>
        );
    }

    return (
        <Button
            size="xs"
            variant={variant}
            onClick={() => void handleClick()}
            disabled={busy || action.disabled}
            aria-label={action.label}
        >
            {busy ? (
                <span
                    aria-hidden="true"
                    className="size-3.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"
                />
            ) : icon}
            {action.label}
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
                <pre className="max-h-64 overflow-auto rounded-md border border-border/40 bg-muted/40 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
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
                    <pre className="max-h-80 overflow-auto rounded-md border border-border/40 bg-muted/40 p-2 font-mono text-xs leading-relaxed">
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
                'my-1 flex flex-col gap-2 rounded-xl border border-border/60 bg-card p-3 text-card-foreground shadow-sm',
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
                                    action={action}
                                    variant={action.variant ?? 'outline'}
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
