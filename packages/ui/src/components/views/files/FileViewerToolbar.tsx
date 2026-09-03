import React from 'react';
import type { EditorView } from '@codemirror/view';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, getModifierLabel } from '@/lib/utils';
import { GoToLineDialog } from '../GoToLineDialog';
import { PreviewToggleButton } from '../PreviewToggleButton';
import { OpenInAppListIcon } from './FilesViewChrome';
import { isHtmlFile, type FileNode } from './filesViewModel';

export interface FileViewerToolbarProps {
  selectedFile: FileNode | null;
  displaySelectedPath: string;
  layout?: 'floating' | 'docked';
  exitFullscreenOnly?: boolean;
  canEdit: boolean;
  isEditingFile: boolean;
  isSaving: boolean;
  autoSaveEnabled: boolean;
  autoSaveStatus: 'saved' | 'idle' | 'saving' | 'error';
  isDirty: boolean;
  onSaveDraft: () => Promise<unknown> | void;
  onToggleAutoSave: () => void;
  openInApps: Array<{ id: string; label: string; appName: string; iconDataUrl?: string }>;
  openInCacheStale: boolean;
  onOpenInApp: (app: { id: string; label: string; appName: string }) => Promise<void>;
  onRefreshOpenInApps: () => Promise<void>;
  onToolbarDropdownOpenChange: (open: boolean) => void;
  isSelectedImage: boolean;
  isSelectedPdf: boolean;
  isUnsupportedBinary: boolean;
  wrapLines: boolean;
  onToggleWrapLines: () => void;
  textViewMode: 'edit' | 'view';
  onToggleSearch: () => void;
  isGoToLineOpen: boolean;
  onOpenGoToLineChange: (open: boolean) => void;
  editorView: EditorView | null;
  canUseShikiFileView: boolean;
  isJson: boolean;
  isHtml: boolean;
  onToggleTextViewMode: () => void;
  isMarkdown: boolean;
  mdViewMode: 'edit' | 'preview';
  onToggleMdViewMode: () => void;
  isDrawio: boolean;
  drawioViewMode: 'edit' | 'preview';
  onToggleDrawioViewMode: () => void;
  diagramSaved: boolean;
  onSaveDiagram: () => Promise<void>;
  jsonViewMode: 'tree' | 'text';
  onToggleJsonViewMode: () => void;
  canCopy: boolean;
  copiedContent: boolean;
  onCopyContent: () => Promise<void>;
  canCopyPath: boolean;
  copiedPath: boolean;
  onCopyPath: () => Promise<void>;
  onDownloadFile?: () => void;
  isMobile: boolean;
  mode: 'full' | 'editor-only';
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onExitFullscreen: () => void;
}

export const FileViewerToolbar: React.FC<FileViewerToolbarProps> = ({
  selectedFile,
  displaySelectedPath,
  layout = 'floating',
  exitFullscreenOnly = false,
  canEdit,
  isEditingFile,
  isSaving,
  autoSaveEnabled,
  autoSaveStatus,
  isDirty,
  onSaveDraft,
  onToggleAutoSave,
  openInApps,
  openInCacheStale,
  onOpenInApp,
  onRefreshOpenInApps,
  onToolbarDropdownOpenChange,
  isSelectedImage,
  isSelectedPdf,
  isUnsupportedBinary,
  wrapLines,
  onToggleWrapLines,
  textViewMode,
  onToggleSearch,
  isGoToLineOpen,
  onOpenGoToLineChange,
  editorView,
  canUseShikiFileView,
  isJson,
  isHtml,
  onToggleTextViewMode,
  isMarkdown,
  mdViewMode,
  onToggleMdViewMode,
  isDrawio,
  drawioViewMode,
  onToggleDrawioViewMode,
  diagramSaved,
  onSaveDiagram,
  jsonViewMode,
  onToggleJsonViewMode,
  canCopy,
  copiedContent,
  onCopyContent,
  canCopyPath,
  copiedPath,
  onCopyPath,
  onDownloadFile,
  isMobile,
  mode,
  isFullscreen,
  onToggleFullscreen,
  onExitFullscreen,
}) => {
  if (!selectedFile) {
    return null;
  }

  const docked = layout === 'docked';
  const wrapperCls = docked
    ? 'pointer-events-auto flex flex-wrap items-center gap-1'
    : 'pointer-events-auto flex items-center gap-1 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-1 shadow-sm';

  const withTooltip = (label: React.ReactNode, trigger: React.ReactElement) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{trigger}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <div className={wrapperCls}>
      {canEdit && isEditingFile && (
        <>
          {isSaving ? (
            <span className="flex items-center gap-1 px-1 text-muted-foreground typography-meta">
              <Icon name="loader-4" className="size-3.5 animate-spin" />
              Saving...
            </span>
          ) : autoSaveEnabled && autoSaveStatus === 'saved' && !isDirty ? (
            <span className="flex items-center gap-1 px-1 text-[color:var(--status-success)] typography-meta">
              <Icon name="check" className="size-3.5" />
              Saved
            </span>
          ) : isDirty ? (
            withTooltip(
              autoSaveEnabled
                ? `Save now (${getModifierLabel()}+S) - auto-saves after 1.5s`
                : `Save now (${getModifierLabel()}+S)`,
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onSaveDraft()}
                className="h-6 gap-1 px-1 text-muted-foreground opacity-80 hover:bg-transparent hover:opacity-100 focus-visible:bg-transparent active:bg-transparent"
                title={
                  autoSaveEnabled
                    ? `Save now (${getModifierLabel()}+S) - auto-saves after 1.5s`
                    : `Save now (${getModifierLabel()}+S)`
                }
                aria-label={`Save (${getModifierLabel()}+S)`}
              >
                <Icon name="save-3" className="size-4" />
              </Button>,
            )
          ) : null}
          {withTooltip(
            autoSaveEnabled ? 'Auto-save on' : 'Manual save',
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleAutoSave}
              className={cn(
                'size-6 p-0 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent',
                autoSaveEnabled
                  ? 'text-foreground opacity-100'
                  : 'text-muted-foreground opacity-65 hover:opacity-100',
              )}
              title={autoSaveEnabled ? 'Auto-save on' : 'Manual save'}
              aria-label={autoSaveEnabled ? 'Auto-save on' : 'Manual save'}
            >
              {autoSaveEnabled ? (
                <Icon name="file-check-fill" className="size-4" />
              ) : (
                <Icon name="file-check" className="size-4" />
              )}
            </Button>,
          )}
        </>
      )}

      <DropdownMenu onOpenChange={onToolbarDropdownOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="size-6 p-0 text-foreground opacity-100 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                  title="Open in desktop app"
                  aria-label="Open in desktop app"
                >
                  <Icon name="file-transfer" className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Open in desktop app
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
          {openInApps.map((app) => (
            <DropdownMenuItem
              key={app.id}
              className="flex items-center gap-2"
              onClick={() => void onOpenInApp(app)}
            >
              <OpenInAppListIcon label={app.label} iconDataUrl={app.iconDataUrl} />
              <span className="typography-ui-label text-foreground">{app.label}</span>
            </DropdownMenuItem>
          ))}
          {openInCacheStale ? (
            <DropdownMenuItem className="flex items-center gap-2" onClick={() => void onRefreshOpenInApps()}>
              <Icon name="refresh" className="size-4" />
              <span className="typography-ui-label text-foreground">Refresh Apps</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {!isSelectedImage && !isSelectedPdf && !isUnsupportedBinary && (
        <>
          {withTooltip(
            wrapLines ? 'Disable line wrap' : 'Enable line wrap',
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleWrapLines}
              className={cn(
                'size-6 p-0 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent',
                wrapLines
                  ? 'text-foreground opacity-100'
                  : 'text-muted-foreground opacity-65 hover:opacity-100',
              )}
              title={wrapLines ? 'Disable line wrap' : 'Enable line wrap'}
            >
              <Icon name="text-wrap" className="size-4" />
            </Button>,
          )}
          {textViewMode === 'edit' && (
            <>
              {withTooltip(
                'Find in file',
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    onToggleSearch();
                    event.currentTarget.blur();
                  }}
                  className="size-6 p-0 text-foreground opacity-100 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                  title="Find in file"
                >
                  <Icon name="search" className="size-4" />
                </Button>,
              )}
              {withTooltip(
                'Go to line',
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => {
                    onOpenGoToLineChange(!isGoToLineOpen);
                    event.currentTarget.blur();
                  }}
                  className="size-6 p-0 text-foreground opacity-100 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                  title="Go to line"
                >
                  <Icon name="menu-fold-2" className="size-4" />
                </Button>,
              )}
              <GoToLineDialog
                open={isGoToLineOpen}
                onOpenChange={onOpenGoToLineChange}
                view={editorView}
                variant="inline"
              />
            </>
          )}
        </>
      )}

      {canUseShikiFileView && canEdit && !isJson && !isHtml && (
        <PreviewToggleButton
          currentMode={textViewMode === 'view' ? 'preview' : 'edit'}
          onToggle={onToggleTextViewMode}
        />
      )}

      {isMarkdown &&
        withTooltip(
          mdViewMode === 'preview' ? 'Switch to edit mode' : 'Switch to preview mode',
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleMdViewMode}
            className={cn(
              'size-6 p-0 transition-colors hover:bg-[var(--interactive-hover)] focus-visible:bg-[var(--interactive-hover)] active:bg-[var(--interactive-hover)]',
              mdViewMode === 'preview'
                ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)] hover:bg-[var(--interactive-selection)] focus-visible:bg-[var(--interactive-selection)] active:bg-[var(--interactive-selection)]'
                : 'text-muted-foreground opacity-65 hover:opacity-100',
            )}
            title={mdViewMode === 'preview' ? 'Switch to edit mode' : 'Switch to preview mode'}
            aria-label={mdViewMode === 'preview' ? 'Switch to edit mode' : 'Switch to preview mode'}
          >
            <Icon name={mdViewMode === 'preview' ? 'eye' : 'eye-off'} className="size-4" />
          </Button>,
        )}

      {isHtmlFile(selectedFile?.path ?? '') && (
        <PreviewToggleButton
          currentMode={isHtml ? 'preview' : 'edit'}
          onToggle={onToggleTextViewMode}
        />
      )}

      {isDrawio && (
        <>
          <PreviewToggleButton
            currentMode={drawioViewMode}
            onToggle={onToggleDrawioViewMode}
          />
          {drawioViewMode === 'preview' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onSaveDiagram()}
              className="size-6 p-0 text-foreground hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title="Save diagram"
            >
              {diagramSaved ? (
                <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
              ) : (
                <Icon name="save-3" className="size-4" />
              )}
            </Button>
          )}
        </>
      )}

      {isJson &&
        withTooltip(
          jsonViewMode === 'tree' ? 'Switch to Text View' : 'Switch to Tree View',
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleJsonViewMode}
            className="size-6 p-0 text-muted-foreground opacity-65 hover:bg-transparent hover:opacity-100 focus-visible:bg-transparent active:bg-transparent"
            title={jsonViewMode === 'tree' ? 'Switch to Text View' : 'Switch to Tree View'}
          >
            {jsonViewMode === 'tree' ? (
              <Icon name="code-sslash" className="size-4" />
            ) : (
              <Icon name="node-tree" className="size-4" />
            )}
          </Button>,
        )}

      {canCopy &&
        withTooltip(
          'Copy file contents',
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onCopyContent()}
            className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
            title="Copy file contents"
            aria-label="Copy file contents"
          >
            {copiedContent ? (
              <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
            ) : (
              <Icon name="clipboard" className="size-4" />
            )}
          </Button>,
        )}

      {canCopyPath &&
        withTooltip(
          `Copy file path (${displaySelectedPath})`,
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void onCopyPath()}
            className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
            title={`Copy file path (${displaySelectedPath})`}
            aria-label={`Copy file path (${displaySelectedPath})`}
          >
            {copiedPath ? (
              <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
            ) : (
              <Icon name="file-copy-2" className="size-4" />
            )}
          </Button>,
        )}

      {onDownloadFile &&
        withTooltip(
          'Save file',
          <Button
            variant="ghost"
            size="sm"
            onClick={onDownloadFile}
            className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
            title="Save file"
            aria-label="Save file"
          >
            <Icon name="download" className="size-4" />
          </Button>,
        )}

      {exitFullscreenOnly ? (
        withTooltip(
          'Exit fullscreen',
          <Button
            variant="ghost"
            size="sm"
            onClick={onExitFullscreen}
            className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
            title="Exit fullscreen"
            aria-label="Exit fullscreen"
          >
            <Icon name="fullscreen-exit" className="size-4" />
          </Button>,
        )
      ) : (
        !isMobile &&
        mode === 'full' &&
        withTooltip(
          isFullscreen ? 'Exit fullscreen' : 'Fullscreen',
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleFullscreen}
            className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <Icon name="fullscreen-exit" className="size-4" />
            ) : (
              <Icon name="fullscreen" className="size-4" />
            )}
          </Button>,
        )
      )}
    </div>
  );
};
