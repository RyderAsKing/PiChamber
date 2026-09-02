import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { JsonTreeViewer } from '@/components/ui/JsonTreeViewer';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { ToolPart as ToolPartType, ToolState as ToolStateUnion } from '@/lib/chat/types';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { MessageFilesDisplay } from '../../FileAttachment';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { DiffViewToggle, type DiffViewMode } from '../DiffViewToggle';
import {
    detectLanguageFromOutput,
    formatEditOutput,
    formatInputForDisplay,
    renderTodoOutput,
    tryParseJsonOutput,
    coerceToText,
} from '../toolRenderers';
import type { ToolPopupContent } from '../types';
import { JsonSummaryView } from './JsonSummaryView';
import { PlainDiffFallback } from './PlainDiffFallback';
import { ToolGitPath, ToolScrollableSection } from './ToolPartChrome';
import { CODE_TAG_PROPS, TOOL_COLLAPSED_CUSTOM_STYLE } from './toolPartStyles';
import {
    extractFirstChangedLineFromDiff,
    getDiffPatchEntries,
    getPatchText,
    type DiffPatchEntry,
} from './toolDiffUtils';
import { getStreamingOutputAppend, getToolOutput, lastOutputLines, STREAM_OUTPUT_MAX_LINES } from './toolOutput';
import {
    buildWritePreviewPatch,
    getRelativePath,
    getToolDiagnosticSection,
    isRecord,
    parseQuestionOutput,
    type ToolStateWithMetadata,
} from './toolRenderUtils';

const getToolOutputLanguage = (
    output: string,
    part: ToolPartType,
    metadata: Record<string, unknown> | undefined,
    input: Record<string, unknown> | undefined,
): string => {
    if (part.tool === 'bash') {
        return 'bash';
    }

    return detectLanguageFromOutput(formatEditOutput(output, part.tool || '', metadata), part.tool || '', input);
};

const getToolOutputText = (
    output: string,
    part: ToolPartType,
    metadata: Record<string, unknown> | undefined,
): string => {
    if (part.tool === 'bash') {
        return output;
    }

    return formatEditOutput(output, part.tool || '', metadata);
};

const StreamingPlainTextOutput: React.FC<{ output: string }> = ({ output }) => {
    const preRef = React.useRef<HTMLPreElement>(null);
    const previousOutputRef = React.useRef('');

    React.useLayoutEffect(() => {
        const element = preRef.current;
        if (!element) {
            return;
        }

        const firstChild = element.firstChild;
        const textNode = firstChild instanceof globalThis.Text
            ? firstChild
            : document.createTextNode('');
        if (textNode !== firstChild) {
            element.replaceChildren(textNode);
        }

        const displayed = lastOutputLines(output, STREAM_OUTPUT_MAX_LINES);
        const append = getStreamingOutputAppend(previousOutputRef.current, displayed);
        if (append === undefined) {
            textNode.data = displayed;
        } else if (append.length > 0) {
            textNode.appendData(append);
        }
        previousOutputRef.current = displayed;
    }, [output]);

    return (
        <pre
            ref={preRef}
            className="m-0 whitespace-pre-wrap break-words"
            style={{
                ...TOOL_COLLAPSED_CUSTOM_STYLE,
                lineHeight: 'round(var(--code-block-line-height), 1px)',
                overflowWrap: 'break-word',
            }}
        />
    );
};

const ToolScrollableTextOutput: React.FC<{
    output: string;
    part: ToolPartType;
    metadata: Record<string, unknown> | undefined;
    input: Record<string, unknown> | undefined;
    isStreaming?: boolean;
}> = ({ output, part, metadata, input, isStreaming = false }) => {
    const renderedOutput = getToolOutputText(output, part, metadata);
    const outputLanguage = getToolOutputLanguage(output, part, metadata, input);
    const jsonResult = React.useMemo(() => tryParseJsonOutput(renderedOutput), [renderedOutput]);
    const [jsonViewMode, setJsonViewMode] = React.useState<'summary' | 'formatted' | 'raw'>('summary');
    const [copiedJson, setCopiedJson] = React.useState(false);

    React.useEffect(() => {
        setJsonViewMode('summary');
        setCopiedJson(false);
    }, [renderedOutput]);

    const handleJsonViewChange = React.useCallback((view: 'summary' | 'formatted' | 'raw', event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        setJsonViewMode(view);
    }, []);

    const handleCopyOutput = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const result = await copyTextToClipboard(renderedOutput);
        if (!result.ok) {
            toast.error("Failed to copy output");
            return;
        }
        setCopiedJson(true);
        if (typeof window !== 'undefined') {
            window.setTimeout(() => setCopiedJson(false), 1200);
        }
    }, [renderedOutput]);

    if (part.tool === 'bash' && isStreaming) {
        return (
            <div className="typography-code text-muted-foreground/90">
                <StreamingPlainTextOutput output={renderedOutput} />
            </div>
        );
    }

    if (jsonResult.isJson) {
        return (
            <div className="tool-output-surface relative p-2 rounded-xl w-full min-w-0">
                <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'summary' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('summary', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={"Show navigable JSON"}
                        title={"Show navigable JSON"}
                    >
                        <Icon name="list-unordered" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'formatted' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('formatted', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={"Show formatted JSON"}
                        title={"Show formatted JSON"}
                    >
                        <Icon name="node-tree" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-6 w-6 rounded-md text-muted-foreground hover:text-foreground', jsonViewMode === 'raw' && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]')}
                        onClick={(event) => handleJsonViewChange('raw', event)}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={"Show raw JSON"}
                        title={"Show raw JSON"}
                    >
                        <Icon name="code-box" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 rounded-md bg-[var(--surface-elevated)]/80 text-muted-foreground hover:text-foreground"
                        onClick={handleCopyOutput}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label={copiedJson ? "Copied output" : "Copy output"}
                        title={copiedJson ? "Copied output" : "Copy output"}
                    >
                        <Icon name={copiedJson ? 'check' : 'file-copy'} className="h-3.5 w-3.5" />
                    </Button>
                </div>
                {jsonViewMode === 'summary' ? (
                    <JsonSummaryView data={jsonResult.data} />
                ) : jsonViewMode === 'formatted' ? (
                    <JsonTreeViewer
                        data={jsonResult.data}
                        initiallyExpandedDepth={1}
                        maxHeight="400px"
                    />
                ) : (
                    <div className="typography-code pr-12 text-muted-foreground/90">
                        <WorkerHighlightedCode
                            language="json"
                            code={renderedOutput}
                            style={TOOL_COLLAPSED_CUSTOM_STYLE}
                            codeStyle={CODE_TAG_PROPS.style}
                            wrap
                        />
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className={part.tool === 'bash' ? 'typography-code text-muted-foreground/90' : undefined}>
            <WorkerHighlightedCode
                language={outputLanguage}
                code={renderedOutput}
                style={TOOL_COLLAPSED_CUSTOM_STYLE}
                codeStyle={CODE_TAG_PROPS.style}
                wrap
            />
        </div>
    );
};

ToolScrollableTextOutput.displayName = 'ToolScrollableTextOutput';



// The rich diff preview is the only tool-card piece that needs the
// @pierre/diffs + Shiki stack; lazy-loading it keeps that stack out of the
// eager chat graph. While the chunk loads, the plain-text patch renders as the
// Suspense fallback, mirroring the preview's own error fallback.
const LazyToolPartDiffPreview = lazyWithChunkRecovery(() => import('./ToolPartDiffPreview'));

const DiffPreview: React.FC<{ diff: string; diffViewMode: DiffViewMode }> = ({ diff, diffViewMode }) => (
    <React.Suspense fallback={<PlainDiffFallback diff={diff} />}>
        <LazyToolPartDiffPreview diff={diff} diffViewMode={diffViewMode} />
    </React.Suspense>
);

interface ToolExpandedContentProps {
    part: ToolPartType;
    state: ToolStateUnion;
    currentDirectory: string;
    isExpanded: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
}

export const ToolExpandedContent: React.FC<ToolExpandedContentProps> = React.memo(({
    part,
    state,
    currentDirectory,
    isExpanded,
    onShowPopup,
}) => {
    const mobileActions = useMobileAppActions();
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
    const stateWithData = state as ToolStateWithMetadata;
    const metadata = stateWithData.metadata;
    const input = stateWithData.input;
    const rawOutput = getToolOutput(part.tool || '', stateWithData.output, metadata?.output, state.status);
    const hasStringOutput = typeof rawOutput === 'string' && rawOutput.length > 0;
    const rawOutputString = typeof rawOutput === 'string' ? rawOutput : '';
    const isStreamingBash = part.tool === 'bash' && state.status === 'running';
    const throttledOutputString = useStreamingTextThrottle({
        text: rawOutputString,
        isStreaming: isStreamingBash,
        identityKey: part.id,
        allowTextReplacement: isStreamingBash,
    });
    const outputString = isStreamingBash ? throttledOutputString : rawOutputString;
    const attachments = stateWithData.attachments;
    const fileDiff = isRecord(metadata?.filediff) ? metadata.filediff : undefined;
    const diffContent = getPatchText((metadata as { patch?: unknown } | undefined)?.patch)
        ?? getPatchText(metadata?.diff)
        ?? getPatchText(fileDiff?.patch)
        ?? getPatchText(fileDiff?.diff)
        ?? null;
    const diffEntries = React.useMemo(
        () => getDiffPatchEntries(metadata, diffContent ?? undefined, (path) => getRelativePath(path, currentDirectory)),
        [currentDirectory, diffContent, metadata]
    );
    const hasVisualDiffEntry = diffEntries.some((entry) => entry.renderMode === 'diff');
    const hideToolInputPreview = part.tool === 'pichamber'
        || part.tool === 'apply_patch'
        || part.tool === 'edit'
        || part.tool === 'multiedit';
    const diagnosticSection = React.useMemo(
        () => getToolDiagnosticSection(part.tool || '', input, metadata, currentDirectory),
        [currentDirectory, input, metadata, part.tool],
    );

    const inputTextContent = React.useMemo(() => {
        if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
            return '';
        }

        if ('command' in input && typeof input.command === 'string' && part.tool === 'bash') {
            return formatInputForDisplay(input, part.tool);
        }

        if (typeof (input as { content?: unknown }).content === 'string') {
            return (input as { content?: string }).content ?? '';
        }

        return formatInputForDisplay(input, part.tool);
    }, [input, part.tool]);
    const hasInputText = !hideToolInputPreview && inputTextContent.trim().length > 0;
    const isWriteLikeTool = part.tool === 'write' || part.tool === 'create' || part.tool === 'file_write';
    const isTodoTool = part.tool === 'todowrite' || part.tool === 'todoread';
    const todoContent = React.useMemo(() => {
        if (Array.isArray(input?.todos)) {
            return JSON.stringify(input.todos);
        }
        return outputString;
    }, [input?.todos, outputString]);
    const writeLikeInputPatch = React.useMemo(() => {
        if (!isWriteLikeTool || !hasInputText) {
            return undefined;
        }
        const filePath = typeof input?.filePath === 'string'
            ? input.filePath
            : typeof input?.file_path === 'string'
                ? input.file_path
                : typeof input?.path === 'string'
                    ? input.path
                    : undefined;
        return buildWritePreviewPatch(filePath, inputTextContent);
    }, [hasInputText, input?.filePath, input?.file_path, input?.path, inputTextContent, isWriteLikeTool]);

    React.useEffect(() => {
        setDiffViewMode('unified');
    }, [part.id]);

    const renderScrollableBlock = (
        content: React.ReactNode,
        options?: { maxHeightClass?: string; className?: string; disableHorizontal?: boolean; outerClassName?: string; followKey?: string }
    ) => (
        <ToolScrollableSection
            maxHeightClass={options?.maxHeightClass}
            className={options?.className}
            disableHorizontal={options?.disableHorizontal}
            outerClassName={options?.outerClassName}
            followKey={options?.followKey}
        >
            {content}
        </ToolScrollableSection>
    );

    const renderResultContent = () => {
        const getEntryAbsolutePath = (entry: DiffPatchEntry) => toAbsoluteFilePath(currentDirectory, entry.filePath ?? entry.title);
        const openEntryFile = (entry: DiffPatchEntry, event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            const line = extractFirstChangedLineFromDiff(entry.patch);
            const absolutePath = getEntryAbsolutePath(entry);
            useUIStore.getState().openContextFileAtLine(currentDirectory, absolutePath, line ?? 1, 1);
            // Dedicated mobile app: the pending file navigation is consumed by
            // the FilesView pane — surface it (workspace drawer Files tab).
            mobileActions?.openFiles();
        };
        const openEntryDiff = (entry: DiffPatchEntry, event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            const absolutePath = getEntryAbsolutePath(entry);
            const store = useUIStore.getState();
            const relativePath = getRelativePath(absolutePath, currentDirectory);
            if (store.isMobile) {
                store.navigateToDiff(relativePath);
                return;
            }
            store.openContextDiff(currentDirectory, relativePath);
        };
        const renderDiagnosticsSection = () => {
            if (!diagnosticSection) {
                return null;
            }

            return (
                <div
                    className="tool-output-surface rounded-xl border p-2 space-y-2"
                    style={{
                        borderColor: 'var(--status-error-border)',
                        backgroundColor: 'var(--status-error-background)',
                    }}
                >
                    <div className="typography-meta font-medium" style={{ color: 'var(--status-error)' }}>
                        {"LSP errors"}
                    </div>
                    <div className="space-y-1">
                        <div className="flex items-center gap-1 min-w-0">
                            <ToolGitPath path={diagnosticSection.displayPath} grow={false} />
                        </div>
                        <div className="space-y-1">
                            {diagnosticSection.diagnostics.map((diagnostic, index) => (
                                <div key={`${diagnosticSection.displayPath}:${diagnostic.line}:${diagnostic.character}:${index}`} className="rounded-md border px-2 py-1" style={{ borderColor: 'var(--status-error-border)', backgroundColor: 'var(--surface-elevated)' }}>
                                    <div className="flex items-start gap-2 min-w-0">
                                        <span className="typography-micro shrink-0" style={{ color: 'var(--status-error)' }}>
                                            [{diagnostic.line}:{diagnostic.character}]
                                        </span>
                                        <span className="typography-meta text-foreground whitespace-pre-wrap break-words">
                                            {diagnostic.message}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {diagnosticSection.remaining > 0 ? (
                            <div className="typography-micro text-muted-foreground">
                                {`+${diagnosticSection.remaining} more errors`}
                            </div>
                        ) : null}
                    </div>
                </div>
            );
        };

        // Question tool: show parsed Q&A summary or question content from input
        if (part.tool === 'question') {
            if (state.status === 'completed' && hasStringOutput) {
                const parsedQA = parseQuestionOutput(outputString);
                if (parsedQA && parsedQA.length > 0) {
                    return renderScrollableBlock(
                        <div className="space-y-2">
                            {parsedQA.map((qa, index) => (
                                <div key={index} className="space-y-0.5">
                                    <div className="typography-micro text-muted-foreground">{qa.question}</div>
                                    <div className="typography-meta text-foreground whitespace-pre-wrap">{qa.answer}</div>
                                </div>
                            ))}
                        </div>,
                        { maxHeightClass: 'max-h-[40vh]' }
                    );
                }
            }

            if (state.status === 'error' && 'error' in state) {
                return (
                    <div>
                        <div className="typography-meta font-medium text-muted-foreground mb-1">{"Error:"}</div>
                        <div className="typography-meta p-2 rounded-xl border" style={{
                            backgroundColor: 'var(--status-error-background)',
                            color: 'var(--status-error)',
                            borderColor: 'var(--status-error-border)',
                        }}>
                            {coerceToText(state.error)}
                        </div>
                    </div>
                );
            }

            // Show question content from input whenever available, whether the tool is
            // pending/running or completed without parseable output. This ensures question
            // text persists across refreshes even if the QuestionCard store data is lost.
            const questionInput = input as { questions?: Array<{ question?: string; header?: string; options?: Array<{ label: string; description: string }>; multiple?: boolean }> } | undefined;
            if (questionInput?.questions && Array.isArray(questionInput.questions) && questionInput.questions.length > 0) {
                return renderScrollableBlock(
                    <div className="space-y-2">
                        {questionInput.questions.map((q, index) => (
                            <div key={index} className="space-y-0.5">
                                {q.header ? (
                                    <div className="typography-micro text-muted-foreground">{coerceToText(q.header)}</div>
                                ) : null}
                                <div className="typography-meta text-foreground">{coerceToText(q.question)}</div>
                                {Array.isArray(q.options) && q.options.length > 0 ? (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {q.options.map((opt) => (
                                            <span key={coerceToText(opt.label)} className="typography-micro px-1.5 py-0.5 rounded bg-muted/30 border border-border/30 text-muted-foreground">
                                                {coerceToText(opt.label)}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>,
                    { maxHeightClass: 'max-h-[40vh]' }
                );
            }

            return <div className="typography-meta text-muted-foreground">{"Awaiting response..."}</div>;
        }

        if (part.tool === 'task' && hasStringOutput) {
            return renderScrollableBlock(
                <div className="w-full min-w-0">
                    <SimpleMarkdownRenderer content={coerceToText(outputString)} variant="tool" onShowPopup={onShowPopup} />
                </div>
            );
        }

        if ((part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch' || part.tool === 'write') && (diffEntries.length > 0 || !!diagnosticSection)) {
            return renderScrollableBlock(
                <div className="space-y-3">
                    {diffEntries.map((entry) => (
                        <div key={entry.id} className="w-full min-w-0">
                            <div className="mb-1 flex min-w-0 items-center gap-1 px-2 py-1">
                                <div className="min-w-0 flex-1 typography-meta font-medium text-muted-foreground">
                                    <ToolGitPath path={entry.title} />
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                    onClick={(event) => openEntryFile(entry, event)}
                                    aria-label={"Open file at first change"}
                                    title={"Open file at first change"}
                                >
                                    <Icon name="file-edit" className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                                    onClick={(event) => openEntryDiff(entry, event)}
                                    aria-label={"Open file diff"}
                                    title={"Open file diff"}
                                >
                                    <Icon name="git-pull-request" className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                            {entry.renderMode === 'diff' ? (
                                <DiffPreview
                                    diff={entry.patch}
                                    diffViewMode={diffViewMode}
                                />
                            ) : (
                                <PlainDiffFallback diff={entry.patch} />
                            )}
                        </div>
                    ))}
                    {renderDiagnosticsSection()}
                </div>,
                { className: 'p-1' }
            );
        }

        if (part.tool === 'write' && diagnosticSection) {
            return renderScrollableBlock(
                <div className="space-y-3">
                    {renderDiagnosticsSection()}
                </div>,
                { className: 'p-1' },
            );
        }

        if (isWriteLikeTool) {
            return null;
        }

        if (hasStringOutput && outputString.trim()) {
            const output = (
                <ToolScrollableTextOutput
                    output={coerceToText(outputString)}
                    part={part}
                    metadata={metadata}
                    input={input}
                    isStreaming={isStreamingBash}
                />
            );

            return renderScrollableBlock(
                output,
                {
                    className: part.tool === 'bash' ? 'p-1 rounded-none' : 'p-1',
                    maxHeightClass: isStreamingBash ? 'max-h-64' : part.tool === 'bash' ? 'max-h-[46vh]' : undefined,
                    followKey: isStreamingBash ? outputString : undefined,
                }
            );
        }

        return renderScrollableBlock(
            <div className="typography-meta text-muted-foreground/70">{"No output produced"}</div>,
            { maxHeightClass: 'max-h-60' }
        );
    };

    const hasVisibleOutput = outputString.trim().length > 0;
    const shouldRenderResult = (state.status === 'completed' && 'output' in state)
        || (part.tool === 'bash' && hasVisibleOutput);

    if (isTodoTool) {
        if (state.status === 'error' && 'error' in state) {
            return (
                <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
                    <div className="typography-meta font-medium text-muted-foreground/80 mb-1">{"Error:"}</div>
                    <div className="typography-meta p-2 rounded-xl border" style={{
                        backgroundColor: 'var(--status-error-background)',
                        color: 'var(--status-error)',
                        borderColor: 'var(--status-error-border)',
                    }}>
                        {state.error}
                    </div>
                </div>
            );
        }

        const todoOutput = renderTodoOutput(todoContent, {
            total: "Total",
            inProgress: "In Progress",
            pending: "Pending",
            completed: "Completed",
            cancelled: "Cancelled",
        }, { unstyled: true });

        return (
            <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-4">
                {renderScrollableBlock(
                    todoOutput ?? (
                        <ToolScrollableTextOutput
                            output={todoContent}
                            part={part}
                            metadata={metadata}
                            input={input}
                        />
                    ),
                    { className: 'p-2', maxHeightClass: 'max-h-[46vh]' },
                )}
            </div>
        );
    }

    return (
        <div
            className={cn(
                'relative pr-2 pb-2 pt-2 space-y-2 pl-4'
            )}
        >
            {part.tool === 'question' ? (
                renderResultContent()
            ) : (
                <>
                    {hasInputText ? (
                        <div className="my-1">
                            {renderScrollableBlock(
                                part.tool === 'bash' ? (
                                    <pre className="tool-input-text whitespace-pre-wrap break-words typography-code text-muted-foreground/90 m-0 p-0">
                                        {inputTextContent}
                                    </pre>
                                ) : isWriteLikeTool && writeLikeInputPatch ? (
                                    <DiffPreview
                                        diff={writeLikeInputPatch}
                                        diffViewMode={diffViewMode}
                                    />
                                ) : (
                                    <blockquote className="tool-input-text whitespace-pre-wrap break-words typography-meta italic text-muted-foreground/70">
                                        {inputTextContent}
                                    </blockquote>
                                ),
                                {
                                    maxHeightClass: isWriteLikeTool && writeLikeInputPatch && isExpanded ? 'max-h-[50vh]' : 'max-h-60',
                                    className: part.tool === 'bash' ? 'tool-input-surface p-0 rounded-none' : 'tool-input-surface',
                                }
                            )}
                        </div>
                    ) : null}

                    {shouldRenderResult && (
                        <div>
                            {(part.tool === 'edit' || part.tool === 'multiedit' || part.tool === 'apply_patch' || part.tool === 'write') && hasVisualDiffEntry ? (
                                <div className="mb-1 flex items-center justify-end gap-2">
                                    <DiffViewToggle
                                        mode={diffViewMode}
                                        onModeChange={setDiffViewMode}
                                        className="h-5 w-5 p-0"
                                    />
                                </div>
                            ) : null}
                            {renderResultContent()}
                        </div>
                    )}

                    {state.status === 'error' && 'error' in state && (
                        <div>
                            <div className="typography-meta font-medium text-muted-foreground/80 mb-1">{"Error:"}</div>
                            <div className="typography-meta p-2 rounded-xl border" style={{
                                backgroundColor: 'var(--status-error-background)',
                                color: 'var(--status-error)',
                                borderColor: 'var(--status-error-border)',
                            }}>
                                {coerceToText(state.error)}
                            </div>
                        </div>
                    )}
                </>
            )}

            {Array.isArray(attachments) && attachments.length > 0 && state.status === 'completed' ? (
                <MessageFilesDisplay files={attachments} onShowPopup={onShowPopup} compact />
            ) : null}
        </div>
    );
});

ToolExpandedContent.displayName = 'ToolExpandedContent';
