import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn, getModifierLabel } from '@/lib/utils';
import { OpenInAppListIcon } from './FilesViewChrome';
import type { FileViewerToolbarProps } from './FileViewerToolbar';
import { isHtmlFile } from './filesViewModel';

type FileActionsMenuProps = Omit<FileViewerToolbarProps, 'layout' | 'exitFullscreenOnly' | 'onExitFullscreen'>;

/** A menu row: label on the left, an optional shortcut or check on the right. */
const Row = ({ label, hint, checked }: { label: string; hint?: string; checked?: boolean }) => (
  <>
    <span className="flex-1">{label}</span>
    {hint ? <span className="ml-4 typography-micro text-muted-foreground">{hint}</span> : null}
    {checked ? <Icon name="check" className="ml-4 size-4 text-foreground" /> : null}
  </>
);

/**
 * The open file's actions behind one ⋯ button, each with a written label:
 * saving, how the file is shown, finding in it, and copying or exporting it.
 * The docked toolbar (a setting, and on phones) keeps the icon row instead.
 */
export const FileActionsMenu: React.FC<FileActionsMenuProps> = ({
  selectedFile,
  displaySelectedPath,
  canEdit,
  isEditingFile,
  isSaving,
  autoSaveEnabled,
  isDirty,
  onSaveDraft,
  onToggleAutoSave,
  canOpenInDesktopApp = true,
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
  onOpenGoToLineChange,
  canUseShikiFileView,
  isJson,
  isHtml,
  onToggleTextViewMode,
  isDrawio,
  drawioViewMode,
  onToggleDrawioViewMode,
  diagramSaved,
  onSaveDiagram,
  jsonViewMode,
  onToggleJsonViewMode,
  canCopy,
  onCopyContent,
  canCopyPath,
  onCopyPath,
  onDownloadFile,
  isMobile,
  mode,
  isFullscreen,
  onToggleFullscreen,
}) => {
  if (!selectedFile) return null;

  const mod = getModifierLabel();
  const isText = !isSelectedImage && !isSelectedPdf && !isUnsupportedBinary;
  const editing = canEdit && isEditingFile;
  const searchable = isText && textViewMode === 'edit';

  // How the file is shown, named for what choosing it does.
  const viewToggle: { label: string; onSelect: () => void } | null = isDrawio
    ? { label: drawioViewMode === 'preview' ? 'Edit diagram source' : 'Show diagram', onSelect: onToggleDrawioViewMode }
    : isHtmlFile(selectedFile.path)
      ? { label: isHtml ? 'Show source' : 'Show page preview', onSelect: onToggleTextViewMode }
      : canUseShikiFileView && canEdit && !isJson && !isHtml
        ? { label: textViewMode === 'view' ? 'Edit file' : 'Read only', onSelect: onToggleTextViewMode }
        : null;

  const editGroup = editing ? (
    <>
      {isDirty && !isSaving ? (
        <DropdownMenuItem onSelect={() => void onSaveDraft()}>
          <Row label={'Save now'} hint={`${mod}+S`} />
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={onToggleAutoSave}>
        <Row label={'Save automatically'} checked={autoSaveEnabled} />
      </DropdownMenuItem>
    </>
  ) : null;

  const viewItems: React.ReactNode[] = [];
  if (viewToggle) {
    viewItems.push(
      <DropdownMenuItem key="view" onSelect={viewToggle.onSelect}>
        <Row label={viewToggle.label} />
      </DropdownMenuItem>,
    );
  }
  if (isJson) {
    viewItems.push(
      <DropdownMenuItem key="json" onSelect={onToggleJsonViewMode}>
        <Row label={jsonViewMode === 'tree' ? 'Show as text' : 'Show as tree'} />
      </DropdownMenuItem>,
    );
  }
  if (isDrawio && drawioViewMode === 'preview') {
    viewItems.push(
      <DropdownMenuItem key="diagram" onSelect={() => void onSaveDiagram()}>
        <Row label={diagramSaved ? 'Diagram saved' : 'Save diagram'} />
      </DropdownMenuItem>,
    );
  }
  if (isText) {
    viewItems.push(
      <DropdownMenuItem key="wrap" onSelect={onToggleWrapLines}>
        <Row label={'Wrap long lines'} checked={wrapLines} />
      </DropdownMenuItem>,
    );
  }
  if (searchable) {
    viewItems.push(
      <DropdownMenuItem key="find" onSelect={onToggleSearch}>
        <Row label={'Find in file'} hint={`${mod}+F`} />
      </DropdownMenuItem>,
      <DropdownMenuItem key="line" onSelect={() => onOpenGoToLineChange(true)}>
        <Row label={'Go to line'} />
      </DropdownMenuItem>,
    );
  }

  const copyItems: React.ReactNode[] = [];
  if (canCopy) {
    copyItems.push(
      <DropdownMenuItem key="copy" onSelect={() => void onCopyContent()}>
        <Row label={'Copy contents'} />
      </DropdownMenuItem>,
    );
  }
  if (canCopyPath) {
    copyItems.push(
      <DropdownMenuItem key="path" onSelect={() => void onCopyPath()}>
        <Row label={'Copy path'} />
      </DropdownMenuItem>,
    );
  }
  if (onDownloadFile) {
    copyItems.push(
      <DropdownMenuItem key="download" onSelect={onDownloadFile}>
        <Row label={'Download'} />
      </DropdownMenuItem>,
    );
  }
  if (canOpenInDesktopApp && openInApps.length > 0) {
    copyItems.push(
      <DropdownMenuSub key="open-in">
        <DropdownMenuSubTrigger>{'Open in'}</DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56 max-h-[70vh] overflow-y-auto">
          {openInApps.map((app) => (
            <DropdownMenuItem key={app.id} className="flex items-center gap-2" onSelect={() => void onOpenInApp(app)}>
              <OpenInAppListIcon label={app.label} iconDataUrl={app.iconDataUrl} />
              <span className="typography-ui-label text-foreground">{app.label}</span>
            </DropdownMenuItem>
          ))}
          {openInCacheStale ? (
            <DropdownMenuItem onSelect={() => void onRefreshOpenInApps()}>{'Refresh apps'}</DropdownMenuItem>
          ) : null}
        </DropdownMenuSubContent>
      </DropdownMenuSub>,
    );
  }

  const showFullscreen = !isMobile && mode === 'full';
  const groups = [editGroup, viewItems.length ? viewItems : null, copyItems.length ? copyItems : null].filter(Boolean);

  return (
    <DropdownMenu onOpenChange={onToolbarDropdownOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('size-7 p-0 text-muted-foreground hover:text-foreground data-[popup-open]:bg-interactive-active data-[popup-open]:text-foreground')}
          aria-label={'File actions'}
          title={'File actions'}
        >
          <Icon name="more-fill" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]" aria-label={`Actions for ${displaySelectedPath}`}>
        {groups.map((group, index) => (
          <React.Fragment key={index}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {group}
          </React.Fragment>
        ))}
        {showFullscreen ? (
          <>
            {groups.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={onToggleFullscreen}>
              <Row label={isFullscreen ? 'Exit full screen' : 'Full screen'} />
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
