import React from 'react';
import { File as PierreFile, PatchDiff } from '@pierre/diffs/react';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { parseReadToolOutput } from './toolRenderers';
import type { ToolPopupContent, DiffViewMode } from './types';
import { VirtualizedCodeBlock, type CodeLine } from './parts/VirtualizedCodeBlock';
import { TOOL_DIFF_METRICS, TOOL_DIFF_UNSAFE_CSS } from './parts/toolPartStyles';
import type { PierreThemeConfig } from './usePierreThemeConfig';

export const DialogUnifiedDiff: React.FC<{
  popup: ToolPopupContent;
  diffViewMode: DiffViewMode;
  pierreThemeConfig: PierreThemeConfig;
}> = React.memo(({ popup, diffViewMode, pierreThemeConfig }) => {
  const patchContent = popup.content || '';

  return (
    <div className="typography-code">
      <PatchDiff
        patch={patchContent}
        metrics={TOOL_DIFF_METRICS}
        options={{
          diffStyle: diffViewMode === 'unified' ? 'unified' : 'split',
          diffIndicators: 'none',
          hunkSeparators: 'line-info-basic',
          lineDiffType: 'none',
          disableFileHeader: true,
          maxLineDiffLength: 1000,
          expansionLineCount: 20,
          overflow: 'wrap',
          theme: pierreThemeConfig.theme,
          themeType: pierreThemeConfig.themeType,
          unsafeCSS: TOOL_DIFF_UNSAFE_CSS,
        }}
        className="block w-full"
      />
    </div>
  );
});

DialogUnifiedDiff.displayName = 'DialogUnifiedDiff';

export const DialogReadContent: React.FC<{
  popup: ToolPopupContent;
  pierreThemeConfig: PierreThemeConfig;
}> = React.memo(({ popup, pierreThemeConfig }) => {
  const parsedReadOutput = React.useMemo(
    () => parseReadToolOutput(popup.content),
    [popup.content]
  );

  const inputMeta = popup.metadata?.input;
  const inputObj =
    typeof inputMeta === 'object' && inputMeta !== null
      ? (inputMeta as Record<string, unknown>)
      : {};
  const offset = typeof inputObj.offset === 'number' ? inputObj.offset : 0;
  const filePath =
    typeof inputObj.file_path === 'string'
      ? inputObj.file_path
      : typeof inputObj.filePath === 'string'
      ? inputObj.filePath
      : typeof inputObj.path === 'string'
      ? inputObj.path
      : 'read-output';

  const fileContents = React.useMemo(
    () => parsedReadOutput.lines.map((line) => line.text).join('\n'),
    [parsedReadOutput]
  );
  const detectedLanguage = React.useMemo(
    () => popup.language || getLanguageFromExtension(filePath) || 'text',
    [filePath, popup.language]
  );

  const codeLines: CodeLine[] = React.useMemo(() => {
    const hasExplicitLineNumbers = parsedReadOutput.lines.some(
      (line) => line.lineNumber !== null
    );
    const result: CodeLine[] = [];
    let nextLineNumber = offset;

    for (const line of parsedReadOutput.lines) {
      if (line.lineNumber !== null) {
        nextLineNumber = line.lineNumber;
      }
      const shouldAssignFallback =
        parsedReadOutput.type === 'file' &&
        !hasExplicitLineNumbers &&
        line.lineNumber === null &&
        !line.isInfo;
      const effectiveLineNumber =
        line.lineNumber ??
        (shouldAssignFallback ? nextLineNumber + 1 : null);
      if (typeof effectiveLineNumber === 'number') {
        nextLineNumber = effectiveLineNumber;
      }

      result.push({
        text: line.text,
        lineNumber: effectiveLineNumber,
        isInfo: line.isInfo,
      });
    }

    return result;
  }, [offset, parsedReadOutput]);

  if (parsedReadOutput.type === 'file') {
    return (
      <PierreFile
        file={{
          name: filePath,
          contents: fileContents,
          lang: detectedLanguage || undefined,
        }}
        options={{
          disableFileHeader: true,
          overflow: 'wrap',
          theme: pierreThemeConfig.theme,
          themeType: pierreThemeConfig.themeType,
        }}
        className="block w-full"
      />
    );
  }

  return (
    <VirtualizedCodeBlock
      lines={codeLines}
      language={detectedLanguage}
      maxHeight="70vh"
    />
  );
});

DialogReadContent.displayName = 'DialogReadContent';
