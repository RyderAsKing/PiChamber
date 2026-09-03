import React from 'react';
import { cn } from '@/lib/utils';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import type { TurnChangedFile } from '../lib/turns/types';

const getDisplayFileName = (file: string): string => {
  const normalized = file.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.at(-1) ?? file;
};

export const TurnChangedFileChipContent = React.memo(
  ({
    file,
    interactive = false,
  }: {
    file: TurnChangedFile;
    interactive?: boolean;
  }) => (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/30 bg-muted/30 px-2 py-1 text-xs text-muted-foreground',
        interactive &&
          'transition-colors hover:border-border/60 hover:bg-interactive-hover'
      )}
      style={{ lineHeight: 'round(1.35em, 1px)' }}
    >
      <FileTypeIcon filePath={file.file} className="h-3.5 w-3.5 flex-shrink-0" />
      <span
        className="max-w-52 truncate text-foreground/80"
        title={file.file}
      >
        {getDisplayFileName(file.file)}
      </span>
      <span
        className="flex-shrink-0 inline-flex items-center gap-0 typography-meta"
        style={{ fontSize: '0.8rem', lineHeight: '1' }}
      >
        <span style={{ color: 'var(--status-success)' }}>+{file.additions}</span>
        <span className="text-muted-foreground/70">/</span>
        <span style={{ color: 'var(--status-error)' }}>-{file.deletions}</span>
      </span>
    </span>
  )
);

export const TurnChangedFilePillButton = React.memo(
  ({
    file,
    onOpen,
    disabled = false,
  }: {
    file: TurnChangedFile;
    onOpen: (file: string) => void;
    disabled?: boolean;
  }) => {
    return (
      <button
        type="button"
        disabled={disabled}
        // `disabled:cursor-default`: the global `:where(button:disabled)`
        // rule would otherwise show not-allowed on settled turns.
        className="inline-flex h-8 max-w-full cursor-pointer items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-default"
        aria-label={`Open ${file.file}`}
        title={file.file}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen(file.file);
        }}
      >
        <TurnChangedFileChipContent file={file} interactive={!disabled} />
      </button>
    );
  }
);

export const TurnChangedFilePills = React.memo(
  ({
    files,
    isInteractive,
  }: {
    files?: TurnChangedFile[];
    isInteractive: boolean;
  }) => {
    const effectiveDirectory = useEffectiveDirectory();
    const isMobile = useUIStore((state) => state.isMobile);
    const navigateToDiff = useUIStore((state) => state.navigateToDiff);
    const openContextDiff = useUIStore((state) => state.openContextDiff);

    const openLastTurnDiff = React.useCallback(
      (file: string) => {
        if (!isMobile && effectiveDirectory) {
          openContextDiff(effectiveDirectory, file, false, 'turn');
          return;
        }

        navigateToDiff(file, false, 'turn');
      },
      [effectiveDirectory, isMobile, navigateToDiff, openContextDiff]
    );

    if (!files || files.length === 0) return null;

    // One stable subtree: the old button<->span swap on `isLatestTurn`
    // remounted every chip (dropping focus and flashing) on send.
    // `disabled` keeps the same DOM with static styling instead.
    return (
      <>
        {files.map((file) => (
          <TurnChangedFilePillButton
            key={file.file}
            file={file}
            onOpen={openLastTurnDiff}
            disabled={!isInteractive}
          />
        ))}
      </>
    );
  }
);
