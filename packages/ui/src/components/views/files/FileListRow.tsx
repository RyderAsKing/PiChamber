import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { cn } from '@/lib/utils';
import { FileChangeMark } from './FileChangeMark';
import type { FileStatus } from './fileChange';

interface FileListRowProps {
  /** Workspace-relative path, shown as name then folder. */
  path: string;
  status?: FileStatus | null;
  active?: boolean;
  onClick: () => void;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>) => void;
  /** Search text; its first occurrence in the name is set in medium weight. */
  match?: string;
}

/** The name with the matched run marked, or the plain name when it doesn't occur. */
const markMatch = (name: string, match: string | undefined): React.ReactNode => {
  const needle = match?.trim().toLowerCase();
  if (!needle) return name;
  const at = name.toLowerCase().indexOf(needle);
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark className="bg-transparent font-semibold text-foreground">{name.slice(at, at + needle.length)}</mark>
      {name.slice(at + needle.length)}
    </>
  );
};

/**
 * A file outside the tree (a search hit, a changed file): its name first,
 * where it lives after in a quieter tone, and its git change at the end.
 */
export const FileListRow: React.FC<FileListRowProps> = ({ path, status, active = false, onClick, onDragStart, match }) => {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const folder = slash >= 0 ? path.slice(0, slash) : '';

  return (
    <button
      type="button"
      onClick={onClick}
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors',
        active ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40',
        onDragStart && 'cursor-grab active:cursor-grabbing',
      )}
      title={path}
    >
      <FileTypeIcon filePath={path} />
      <span className="min-w-0 truncate typography-meta text-foreground">
        {markMatch(name, match)}
      </span>
      {/* rtl drops the start of a long folder, keeping the part nearest the file. */}
      <span className="min-w-0 flex-1 truncate pl-1 typography-meta text-muted-foreground [direction:rtl] [text-align:left]">
        <bdi>{folder}</bdi>
      </span>
      {status ? <FileChangeMark status={status} /> : null}
    </button>
  );
};
