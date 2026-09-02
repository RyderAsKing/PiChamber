import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useTransientValue } from '@/hooks/useTransientValue';
import type { ShellActionPartLike, SubtaskPartLike } from './userAuxiliaryPartsModel';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';

const normalizeSubtaskModel = (model: SubtaskPartLike['model']): string | null => {
    if (!model || typeof model !== 'object') return null;
    const providerID = typeof model.providerID === 'string' ? model.providerID.trim() : '';
    const modelID = typeof model.modelID === 'string' ? model.modelID.trim() : '';
    if (!providerID || !modelID) return null;
    return `${providerID}/${modelID}`;
};

export const UserSubtaskPart: React.FC<{ part: SubtaskPartLike }> = ({ part }) => {
    const [expanded, setExpanded] = React.useState(false);
    const effectiveDirectory = useEffectiveDirectory();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    // On the dedicated mobile shell, swapping to the subtask session with
    // the sessions drawer still open leaves the user staring at the drawer
    // covering the new chat. The shell exposes `closeDrawers` for exactly
    // this — no-op when running on web/desktop.
    const mobileActions = useMobileAppActions();

    const description = typeof part.description === 'string' ? part.description.trim() : '';
    const command = typeof part.command === 'string' ? part.command.trim() : '';
    const agent = typeof part.agent === 'string' ? part.agent.trim() : '';
    const prompt = typeof part.prompt === 'string' ? part.prompt.trim() : '';
    const taskSessionID = typeof part.taskSessionID === 'string' ? part.taskSessionID.trim() : '';
    const model = normalizeSubtaskModel(part.model);

    const openSubtaskSession = React.useCallback(() => {
        if (!effectiveDirectory || !taskSessionID) return;
        setCurrentSession(taskSessionID, effectiveDirectory);
        mobileActions?.closeDrawers?.();
    }, [effectiveDirectory, taskSessionID, setCurrentSession, mobileActions]);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">{"Delegated task"}</span>
                {command ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        /{command}
                    </span>
                ) : null}
                {agent ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        @{agent}
                    </span>
                ) : null}
                {model ? (
                    <span className="inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none bg-foreground/5 text-muted-foreground">
                        {model}
                    </span>
                ) : null}
            </div>

            {description ? (
                <div className="typography-ui-label text-foreground/90 mt-1.5">
                    {description}
                </div>
            ) : null}

            {prompt ? (
                <div className="mt-2 border-t border-border/60 pt-1.5">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                        onClick={() => setExpanded((value) => !value)}
                    >
                        {expanded ? "Hide prompt" : "Show prompt"}
                    </button>
                    {expanded ? (
                        <pre className="typography-meta mt-1.5 overflow-x-auto whitespace-pre-wrap break-words text-foreground/85" data-no-drawer-swipe="true">
                            {prompt}
                        </pre>
                    ) : null}
                </div>
            ) : null}

            {taskSessionID ? (
                <div className="mt-1.5">
                    <button
                        type="button"
                        className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                        onClick={openSubtaskSession}
                    >
                        {"Open subtask session"}
                    </button>
                </div>
            ) : null}
        </div>
    );
};

const SHELL_CODE_TAG_STYLE: React.CSSProperties = { background: 'transparent', backgroundColor: 'transparent' };

export const UserShellActionPart: React.FC<{ part: ShellActionPartLike }> = ({ part }) => {
    const output = typeof part.shellAction?.output === 'string' ? part.shellAction.output : '';
    const [expanded, setExpanded] = React.useState(true);
    const { value: copiedOutput, show: showCopiedOutput } = useTransientValue(false, 2000);

    const command = typeof part.shellAction?.command === 'string' ? part.shellAction.command.trim() : '';
    const status = typeof part.shellAction?.status === 'string' ? part.shellAction.status.trim().toLowerCase() : '';
    const hasOutput = output.trim().length > 0;
    const copyOutputToClipboard = React.useCallback(async () => {
        if (!hasOutput) return;

        const result = await copyTextToClipboard(output);
        if (!result.ok) return;

        showCopiedOutput(true);
    }, [hasOutput, output, showCopiedOutput]);

    return (
        <div className="mt-2">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="typography-meta font-semibold text-foreground">{"Shell command"}</span>
                {status ? (
                    <span className={cn(
                        'inline-flex h-5 items-center rounded px-1.5 text-[11px] leading-none',
                        status === 'error'
                            ? 'bg-[var(--status-error-background)] text-[var(--status-error)]'
                            : 'bg-foreground/5 text-muted-foreground'
                    )}>
                        {status}
                    </span>
                ) : null}
            </div>

            {command ? (
                <div className="typography-meta mt-1.5 overflow-x-auto font-mono" data-no-drawer-swipe="true">
                    <WorkerHighlightedCode
                        language="bash"
                        code={command}
                        codeStyle={SHELL_CODE_TAG_STYLE}
                        wrap
                    />
                </div>
            ) : null}

            {hasOutput ? (
                <div className="mt-2 border-t border-border/60 pt-1.5">
                    <div className="flex items-center gap-3 flex-wrap">
                        <button
                            type="button"
                            className="typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                            onClick={() => setExpanded((value) => !value)}
                        >
                            {expanded ? "Hide output" : "Show output"}
                        </button>
                        <button
                            type="button"
                            className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => {
                                void copyOutputToClipboard();
                            }}
                            aria-label={copiedOutput ? "Copied" : "Copy output"}
                            title={copiedOutput ? "Copied" : "Copy output"}
                        >
                            {copiedOutput ? <Icon name="check" className="h-3.5 w-3.5" /> : <Icon name="file-copy" className="h-3.5 w-3.5" />}
                        </button>
                    </div>
                    {expanded ? (
                        <div className="typography-meta mt-1.5 max-h-56 overflow-auto font-mono text-foreground/85">
                            <WorkerHighlightedCode
                                language="bash"
                                code={output}
                                codeStyle={SHELL_CODE_TAG_STYLE}
                                wrap
                            />
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
