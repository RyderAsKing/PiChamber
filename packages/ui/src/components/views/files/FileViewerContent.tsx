import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { File as PierreFile } from '@pierre/diffs/react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { DiagramEditor } from '@/components/diagram/DiagramEditor';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { JsonTreeView } from '@/components/ui/JsonTreeView';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { PIERRE_STICKY_SCROLLBAR_HIDE_CSS } from '@/components/views/pierreScrollSync';
import { StickyHorizontalScrollbar } from '@/components/views/StickyHorizontalScrollbar';
import { cn } from '@/lib/utils';
import { getLanguageFromExtension, isDrawioFile } from '@/lib/toolHelpers';
import {
  isHtmlFile,
  isJsonFile,
  isMarkdownFile,
  type FileNode,
} from './filesViewModel';

type PreviewViewMode = 'preview' | 'edit';

type FileViewerContentProps = {
  variant: 'embedded' | 'fullscreen';
  selectedFile: FileNode | null;
  loading: boolean;
  suppressLoadingIndicator: boolean;
  fileError: string | null;
  isSelectedImage: boolean;
  imageSrc: string;
  imagePreviewNonce: number;
  isSelectedPdf: boolean;
  pdfSrc: string;
  pdfPreviewNonce: number;
  isUnsupportedBinary: boolean;
  onDownload?: () => void;
  enableRichPreviews: boolean;
  drawioViewMode: PreviewViewMode;
  drawioRemountNonce: number;
  diagramEditorRef: React.RefObject<React.ComponentRef<typeof DiagramEditor> | null>;
  diagramEditorXml: string;
  onDiagramChange: (xml: string) => void;
  jsonViewMode: 'tree' | 'text';
  markdownViewMode: PreviewViewMode;
  htmlViewMode: PreviewViewMode;
  htmlLoading: boolean;
  htmlPreviewNonce: number;
  htmlPreviewSrc?: string;
  fileContent: string;
  canUseShikiFileView: boolean;
  textViewMode: 'view' | 'edit';
  draftContent: string;
  onDraftChange: (value: string) => void;
  canEdit: boolean;
  vimMode: boolean;
  editorExtensions: Extension[];
  editorWrapperRef?: React.RefObject<HTMLDivElement | null>;
  shouldMaskEditorForPendingNavigation: boolean;
  onEditorViewReady: (view: EditorView) => void;
  onEditorViewDestroy: () => void;
  enableSearch?: boolean;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  pierreTheme: { light: string; dark: string };
  shikiThemeType: 'dark' | 'light';
  wrapLines: boolean;
};

export const FileViewerContent: React.FC<FileViewerContentProps> = ({
  variant,
  selectedFile,
  loading,
  suppressLoadingIndicator,
  fileError,
  isSelectedImage,
  imageSrc,
  imagePreviewNonce,
  isSelectedPdf,
  pdfSrc,
  pdfPreviewNonce,
  isUnsupportedBinary,
  onDownload,
  enableRichPreviews,
  drawioViewMode,
  drawioRemountNonce,
  diagramEditorRef,
  diagramEditorXml,
  onDiagramChange,
  jsonViewMode,
  markdownViewMode,
  htmlViewMode,
  htmlLoading,
  htmlPreviewNonce,
  htmlPreviewSrc,
  fileContent,
  canUseShikiFileView,
  textViewMode,
  draftContent,
  onDraftChange,
  canEdit,
  vimMode,
  editorExtensions,
  editorWrapperRef,
  shouldMaskEditorForPendingNavigation,
  onEditorViewReady,
  onEditorViewDestroy,
  enableSearch = false,
  searchOpen,
  onSearchOpenChange,
  pierreTheme,
  shikiThemeType,
  wrapLines,
}) => {
  const { t } = useTranslation();
  const spacious = variant === 'fullscreen';
  const contentPadding = spacious ? 'p-4' : 'p-3';
  const isDrawio = Boolean(selectedFile?.path && isDrawioFile(selectedFile.path));
  const isJson = Boolean(selectedFile?.path && isJsonFile(selectedFile.path));
  const isMarkdown = Boolean(selectedFile?.path && isMarkdownFile(selectedFile.path));
  const isHtml = Boolean(selectedFile?.path && isHtmlFile(selectedFile.path));

  const pierreFileHostRef = React.useRef<HTMLDivElement | null>(null);

  const renderShikiFileView = () => {
    if (!selectedFile) return null;
    // The wrapper creates no scroll container, so the proxy bar below
    // sticks to the outer ScrollableOverlay pane. CodeMirror edit mode is
    // untouched (its own .cm-scroller is already the pane).
    return (
      <div className="relative h-full" ref={pierreFileHostRef}>
        <PierreFile
          file={{
            name: selectedFile.name,
            contents: draftContent,
            lang: getLanguageFromExtension(selectedFile.path) || undefined,
          }}
          options={{
            disableFileHeader: true,
            overflow: wrapLines ? 'wrap' : 'scroll',
            theme: pierreTheme,
            themeType: shikiThemeType,
            // Hide Pierre's native bottom bar while the sticky proxy bar
            // drives the shadow scroller. Wrap mode keeps native behavior:
            // the rule only matches `[data-overflow="scroll"]`.
            ...(wrapLines ? {} : { unsafeCSS: PIERRE_STICKY_SCROLLBAR_HIDE_CSS }),
          }}
          className="block h-full w-full"
          style={{ height: '100%' }}
        />
        <StickyHorizontalScrollbar hostRef={pierreFileHostRef} enabled={!wrapLines} />
      </div>
    );
  };

  return (
    <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
      {!selectedFile ? (
        <div className={`${contentPadding} typography-ui text-muted-foreground`}>{t("Pick a file from the tree.")}</div>
      ) : loading ? (
        suppressLoadingIndicator
          ? <div className={contentPadding} />
          : (
            <div className={`${contentPadding} flex items-center gap-2 typography-ui text-muted-foreground`}>
              <Icon name="loader-4" className="size-4 animate-spin" />
              {spacious ? t('Loading…') : t("Loading...")}
            </div>
          )
      ) : fileError ? (
        <div className={`${contentPadding} typography-ui text-[color:var(--status-error)]`}>{fileError}</div>
      ) : isSelectedImage ? (
        <div className={cn('flex h-full items-center justify-center', contentPadding)}>
          <img
            key={imagePreviewNonce}
            src={imageSrc}
            alt={selectedFile.name || t("Image")}
            className={cn(
              'max-w-full object-contain rounded-md border border-border/30 bg-primary/10',
              spacious ? 'max-h-full' : 'max-h-[70vh]',
            )}
          />
        </div>
      ) : isSelectedPdf ? (
        <div className="h-full overflow-hidden bg-[var(--surface-background)]">
          <iframe
            key={pdfPreviewNonce}
            src={pdfSrc}
            className="h-full w-full border-0"
            title={selectedFile.name}
          />
        </div>
      ) : isUnsupportedBinary ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="typography-ui-header text-foreground">{t("Cannot preview binary file")}</div>
          <div className="max-w-md typography-ui text-muted-foreground">{t("This file is binary and cannot be edited in PiChamber. Download it to open with another app.")}</div>
          {onDownload ? (
            <Button type="button" variant="outline" size="sm" onClick={onDownload}>
              <Icon name="download" className="mr-2 size-4" />
              {t("Save file")}
            </Button>
          ) : null}
        </div>
      ) : enableRichPreviews && isDrawio && drawioViewMode === 'preview' ? (
        <div className="h-full overflow-hidden" style={{ minHeight: '400px' }}>
          <DiagramEditor
            key={`${selectedFile.path}:${drawioRemountNonce}`}
            ref={diagramEditorRef}
            xml={diagramEditorXml}
            onChange={onDiagramChange}
          />
        </div>
      ) : enableRichPreviews && isJson && jsonViewMode === 'tree' ? (
        <ErrorBoundary
          fallback={
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
              <div className="mb-1 font-medium text-destructive">{t("JSON viewer unavailable")}</div>
              <div className="text-sm text-muted-foreground">{t("Switch to text mode to view raw content.")}</div>
            </div>
          }
        >
          <div className="h-full overflow-auto">
            <JsonTreeView jsonString={fileContent} maxHeight="100%" initiallyExpandedDepth={2} />
          </div>
        </ErrorBoundary>
      ) : isMarkdown && markdownViewMode === 'preview' ? (
        <div className={cn('h-full overflow-auto', contentPadding)}>
          {fileContent.length > 500 * 1024 ? (
            <div className="mb-3 rounded-md border border-status-warning/20 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
              {t('This file is large ({{size}}KB). Preview may be limited.', { size: Math.round(fileContent.length / 1024) })}
            </div>
          ) : null}
          <ErrorBoundary
            fallback={
              <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                <div className="mb-1 font-medium text-destructive">{t("Preview unavailable")}</div>
                <div className="text-sm text-muted-foreground">{t("Switch to edit mode to fix the issue.")}</div>
              </div>
            }
          >
            <SimpleMarkdownRenderer
              content={fileContent}
              className="typography-markdown-body"
              stripFrontmatter
              enableFileReferences={false}
            />
          </ErrorBoundary>
        </div>
      ) : enableRichPreviews && isHtml && htmlViewMode === 'preview' ? (
        htmlLoading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground typography-ui-label">{t("Loading...")}</div>
        ) : (
          <div className="h-full overflow-hidden">
            <iframe
              key={htmlPreviewNonce}
              src={htmlPreviewSrc}
              className="w-full h-full border-none"
              sandbox="allow-scripts allow-same-origin allow-forms"
              title={t("HTML Preview")}
            />
          </div>
        )
      ) : canUseShikiFileView && textViewMode === 'view' ? (
        renderShikiFileView()
      ) : (
        <div
          className={cn('relative h-full', shouldMaskEditorForPendingNavigation && 'overflow-hidden')}
          ref={editorWrapperRef}
        >
          <div className={cn('h-full', shouldMaskEditorForPendingNavigation && 'invisible')}>
            <CodeMirrorEditor
              value={draftContent}
              onChange={onDraftChange}
              readOnly={!canEdit}
              vimMode={vimMode}
              extensions={editorExtensions}
              className="h-full"
              onViewReady={onEditorViewReady}
              onViewDestroy={onEditorViewDestroy}
              {...(enableSearch ? {
                enableSearch: true,
                searchOpen,
                onSearchOpenChange,
              } : {})}
            />
          </div>
          {shouldMaskEditorForPendingNavigation ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background">
              <div className="flex items-center gap-2 typography-ui text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />
                {t("Opening file at change...")}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </ScrollableOverlay>
  );
};
