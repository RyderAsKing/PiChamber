import React from 'react';

import { getLanguageFromExtension, isImageFile } from '@/lib/toolHelpers';
import { PierreDiffViewer } from '../PierreDiffViewer';
import type { DiffData } from './diffTypes';

export const BinaryDiffPlaceholder = React.memo(function BinaryDiffPlaceholder() {
  return (
    <div className="rounded-lg border border-border/60 bg-background px-3 py-2">
      <div className="typography-meta text-muted-foreground">{"Content of this file cannot be viewed."}</div>
    </div>
  );
});

export interface InlineImageDiffViewerProps {
  filePath: string;
  diff: DiffData;
  renderSideBySide: boolean;
}

export const InlineImageDiffViewer = React.memo<InlineImageDiffViewerProps>(function InlineImageDiffViewer({
  filePath,
  diff,
  renderSideBySide,
}) {
  const hasOriginal = diff.original.length > 0;
  const hasModified = diff.modified.length > 0;

  const containerClass = renderSideBySide
    ? 'flex flex-row gap-6 items-start justify-center'
    : 'flex flex-col gap-4 items-center';

  const imageContainerClass = renderSideBySide
    ? 'flex flex-col items-center gap-2 flex-1 min-w-0'
    : 'flex flex-col items-center gap-2';

  return (
    <div className="w-full overflow-auto p-4" style={{ contain: 'layout' }}>
      <div className={containerClass}>
        {hasOriginal && (
          <div className={imageContainerClass}>
            <span className="typography-meta text-muted-foreground font-medium">{"Original"}</span>
            <img
              src={diff.original}
              alt={`Original: ${filePath}`}
              className={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
              style={{ imageRendering: 'auto' }}
            />
          </div>
        )}
        {hasModified && (
          <div className={imageContainerClass}>
            <span className="typography-meta text-muted-foreground font-medium">
              {hasOriginal ? "Modified" : "New"}
            </span>
            <img
              src={diff.modified}
              alt={`Modified: ${filePath}`}
              className={renderSideBySide ? "max-w-full max-h-[70vh] object-contain" : "max-w-full object-contain"}
              style={{ imageRendering: 'auto' }}
            />
          </div>
        )}
      </div>
    </div>
  );
});

export interface InlineDiffViewerProps {
  filePath: string;
  diff: DiffData;
  renderSideBySide: boolean;
  wrapLines: boolean;
}

export const InlineDiffViewer = React.memo<InlineDiffViewerProps>(function InlineDiffViewer({
  filePath,
  diff,
  renderSideBySide,
  wrapLines,
}) {
  const language = React.useMemo(
    () => getLanguageFromExtension(filePath) || 'text',
    [filePath]
  );

  if (diff.isBinary) {
    return <BinaryDiffPlaceholder />;
  }

  if (isImageFile(filePath)) {
    return (
      <InlineImageDiffViewer
        filePath={filePath}
        diff={diff}
        renderSideBySide={renderSideBySide}
      />
    );
  }

  return (
    <div className="w-full" style={{ contain: 'layout' }}>
      <PierreDiffViewer
        original={diff.original}
        modified={diff.modified}
        fileDiff={diff.fileDiff}
        language={language}
        fileName={filePath}
        renderSideBySide={renderSideBySide}
        wrapLines={wrapLines}
        layout="inline"
      />
    </div>
  );
});
