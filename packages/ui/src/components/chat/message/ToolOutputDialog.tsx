import React from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { File as PierreFile } from '@pierre/diffs/react';
import { WorkerHighlightedCode } from '@/components/code/WorkerHighlightedCode';
import { cn } from '@/lib/utils';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { toolDisplayStyles } from '@/lib/typography';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import {
    renderTodoOutput,
    renderListOutput,
    renderGrepOutput,
    renderGlobOutput,
    renderWebSearchOutput,
    formatInputForDisplay,
    tryParseJsonOutput,
} from './toolRenderers';
import type { ToolPopupContent, DiffViewMode } from './types';
import { DiffViewToggle } from './DiffViewToggle';
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { Icon } from "@/components/icon/Icon";
import { getToolIcon } from './ToolOutputDialogIcons';
import { ImagePreviewDialog, MermaidPreviewDialog } from './ToolOutputPreviewDialogs';
import { DialogUnifiedDiff, DialogReadContent } from './ToolOutputDiffComponents';
import { usePierreThemeConfig } from './usePierreThemeConfig';

interface ToolOutputDialogProps {
    popup: ToolPopupContent;
    onOpenChange: (open: boolean) => void;
    isMobile: boolean;
}

const DIALOG_CODE_TAG_PROPS = { style: { background: 'transparent', backgroundColor: 'transparent', fontSize: 'inherit' } };

const ToolOutputDialog: React.FC<ToolOutputDialogProps> = ({ popup, onOpenChange, isMobile }) => {
    const [diffViewMode, setDiffViewMode] = React.useState<DiffViewMode>('unified');
    const pierreThemeConfig = usePierreThemeConfig();

    React.useEffect(() => {
        if (!popup.open) return;
        setDiffViewMode('unified');
    }, [popup.open, popup.title]);

    if (popup.image) {
        return <ImagePreviewDialog popup={popup} onOpenChange={onOpenChange} isMobile={isMobile} />;
    }

    if (popup.mermaid) {
        return <MermaidPreviewDialog popup={popup} onOpenChange={onOpenChange} isMobile={isMobile} />;
    }

    return (
        <Dialog open={popup.open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    'overflow-hidden flex flex-col min-h-0 pt-3 pb-4 px-4 gap-1',
                    '[&>button]:top-1.5',
                    isMobile ? 'w-[95vw] max-w-[95vw]' : 'max-w-5xl',
                    isMobile ? '[&>button]:right-1' : '[&>button]:top-2.5 [&>button]:right-4'
                )}
                style={{ maxHeight: '90vh' }}
            >
                <div className="flex-shrink-0 pb-1">
                    <div className="flex items-start gap-2 text-foreground typography-ui-header font-semibold">
                        {popup.metadata?.tool ? getToolIcon(popup.metadata.tool as string) : (
                            <Icon name="tools" className="h-3.5 w-3.5 text-foreground flex-shrink-0" />
                        )}
                        <span className="break-words flex-1 leading-tight">{popup.title}</span>
                        {popup.isDiff && (
                            <DiffViewToggle
                                mode={diffViewMode}
                                onModeChange={setDiffViewMode}
                                className="mr-8 flex-shrink-0"
                            />
                        )}
                    </div>
                </div>
                <div className="flex-1 min-h-0 rounded-xl border border-border/30 bg-muted/10 overflow-hidden">
                    <div className="tool-output-surface h-full max-h-[75vh] overflow-y-auto px-3 pr-4">
                        {popup.metadata?.input && typeof popup.metadata.input === 'object' &&
                            Object.keys(popup.metadata.input).length > 0 &&
                            popup.metadata?.tool !== 'todowrite' &&
                            popup.metadata?.tool !== 'todoread' &&
                            popup.metadata?.tool !== 'apply_patch' ? (() => {
                                const meta = popup.metadata!;
                                const input = meta.input as Record<string, unknown>;

                                const getInputValue = (key: string): string | null => {
                                  const val = input[key];
                                  return typeof val === 'string' ? val : (typeof val === 'number' ? String(val) : null);
                                };
                                return (
                                <div className="border-b border-border/20 p-4 -mx-3">
                                    <div className="typography-markdown font-medium text-muted-foreground mb-2 px-3">
                                        {meta.tool === 'bash'
                                            ? 'Command:'
                                            : meta.tool === 'task'
                                                ? 'Task Details:'
                                                : 'Input:'}
                                    </div>
                                    {meta.tool === 'bash' && getInputValue('command') ? (
                                        <div className="tool-input-surface bg-transparent rounded-xl border border-border/20 mx-3">
                                            <WorkerHighlightedCode
                                                language="bash"
                                                code={getInputValue('command')!}
                                                style={toolDisplayStyles.getPopupStyles()}
                                                codeStyle={DIALOG_CODE_TAG_PROPS.style}
                                                wrap
                                            />
                                        </div>
                                    ) : meta.tool === 'task' && getInputValue('prompt') ? (
                                        <div
                                            className="tool-input-surface bg-transparent rounded-xl border border-border/20 font-mono whitespace-pre-wrap text-foreground/90 mx-3"
                                            style={toolDisplayStyles.getPopupStyles()}
                                        >
                                            {getInputValue('description') ? `Task: ${getInputValue('description')}\n` : ''}
                                            {getInputValue('subagent_type') ? `Agent Type: ${getInputValue('subagent_type')}\n` : ''}
                                            {`Instructions:\n${getInputValue('prompt')}`}
                                        </div>
                                    ) : meta.tool === 'write' && getInputValue('content') ? (
                                        <div className="tool-input-surface bg-transparent rounded-xl border border-border/20 mx-3">
                                            <PierreFile
                                                file={{
                                                    name: getInputValue('filePath') || getInputValue('file_path') || 'new-file',
                                                    contents: getInputValue('content')!,
                                                    lang: getLanguageFromExtension(getInputValue('filePath') || getInputValue('file_path') || '') || undefined,
                                                }}
                                                options={{
                                                    disableFileHeader: true,
                                                    overflow: 'wrap',
                                                    theme: pierreThemeConfig.theme,
                                                    themeType: pierreThemeConfig.themeType,
                                                }}
                                                className="block w-full"
                                            />
                                        </div>
                                    ) : (
                                        <div
                                            className="tool-input-surface bg-transparent rounded-xl border border-border/20 font-mono whitespace-pre-wrap text-foreground/90 mx-3"
                                            style={toolDisplayStyles.getPopupStyles()}
                                        >
                                            {formatInputForDisplay(input, meta.tool as string)}
                                        </div>
                                    )}
                                </div>
                            );
                            })() : null}

                        {popup.isDiff ? (
                            <DialogUnifiedDiff
                                popup={popup}
                                diffViewMode={diffViewMode}
                                pierreThemeConfig={pierreThemeConfig}
                            />
                        ) : popup.content ? (
                        <div className="p-4">
                            {(() => {
                                const tool = popup.metadata?.tool;

                                if (tool === 'todowrite' || tool === 'todoread') {
                                    return (
                                        renderTodoOutput(popup.content, {
                                            total: "Total",
                                            inProgress: "In Progress",
                                            pending: "Pending",
                                            completed: "Completed",
                                            cancelled: "Cancelled",
                                        }) || (
                                            <WorkerHighlightedCode
                                                language="json"
                                                code={popup.content}
                                                style={toolDisplayStyles.getPopupContainerStyles()}
                                                codeStyle={DIALOG_CODE_TAG_PROPS.style}
                                                wrap
                                            />
                                        )
                                    );
                                }

                                if (tool === 'list') {
                                    return (
                                        renderListOutput(popup.content) || (
                                            <pre className="typography-markdown bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                );
                                }

                                if (tool === 'grep') {
                                    return (
                                        renderGrepOutput(popup.content, isMobile) || (
                                            <pre className="typography-code bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                    );
                                }

                                if (tool === 'glob') {
                                    return (
                                        renderGlobOutput(popup.content, isMobile) || (
                                            <pre className="typography-code bg-muted/30 p-2 rounded-xl border border-border/20 font-mono whitespace-pre-wrap">
                                                {popup.content}
                                            </pre>
                                        )
                                    );
                                }

                                if (tool === 'task' || tool === 'reasoning') {
                                    return (
                                        <div className={tool === 'reasoning' ? "text-muted-foreground/70" : ""}>
                                            <SimpleMarkdownRenderer content={popup.content} variant="tool" />
                                        </div>
                                    );
                                }

                                if (tool === 'web-search' || tool === 'websearch' || tool === 'search_web') {
                                    return (
                                        renderWebSearchOutput(popup.content) || (
                                            <WorkerHighlightedCode
                                                language="text"
                                                code={popup.content}
                                                style={toolDisplayStyles.getPopupContainerStyles()}
                                                codeStyle={DIALOG_CODE_TAG_PROPS.style}
                                                wrap
                                            />
                                        )
                                    );
                                }

                                if (tool === 'read') {
                                    return <DialogReadContent popup={popup} pierreThemeConfig={pierreThemeConfig} />;
                                }

                                // JSON tree viewer for generic JSON outputs
                                const jsonResult = popup.content ? tryParseJsonOutput(popup.content) : { data: null, isJson: false };
                                if (jsonResult.isJson) {
                                    return (
                                        <JsonTreeView
                                            jsonString={popup.content}
                                            initiallyExpandedDepth={3}
                                            maxHeight="70vh"
                                        />
                                    );
                                }

                                return (
                                    <WorkerHighlightedCode
                                        language={popup.language || 'text'}
                                        code={popup.content}
                                        style={toolDisplayStyles.getPopupContainerStyles()}
                                        codeStyle={DIALOG_CODE_TAG_PROPS.style}
                                        wrap
                                    />
                                );
                            })()}
                        </div>
                    ) : (
                        <div className="p-8 text-muted-foreground typography-ui-header">
                            <div className="mb-2">{"Command completed successfully"}</div>
                            <div className="typography-meta">{"No output was produced"}</div>
                        </div>
                    )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default ToolOutputDialog;
