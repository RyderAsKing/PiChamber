import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { FileChangeMark } from '@/components/views/files/FileChangeMark';
import { fileChangeTextClass } from '@/components/views/files/fileChange';
import { classifyGitFileStatus } from '@/components/views/files/fileTreeStatus';
import { useGitStatus } from '@/stores/useGitStore';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import { cn } from '@/lib/utils';
import { useOpenContextEditorFile } from './useOpenContextEditorFile';

/**
 * The editor area with no file open. Besides pointing at the tree, it lists
 * the workspace's changed files, which are usually the ones worth opening
 * after an agent turn. Deleted files are left out: there is nothing to open.
 */
export const FilesEmptyState: React.FC<{ directory: string }> = ({ directory }) => {
  const root = normalizeDirectoryPathKey(directory.trim());
  const gitStatus = useGitStatus(directory);
  const openFile = useOpenContextEditorFile(root);

  const changed = React.useMemo(() => {
    const seen = new Set<string>();
    const rows: Array<{ path: string; status: NonNullable<ReturnType<typeof classifyGitFileStatus>> }> = [];
    for (const file of gitStatus?.files ?? []) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      const status = classifyGitFileStatus(file);
      if (!status || status === 'git-deleted') continue;
      rows.push({ path: file.path, status });
    }
    return rows;
  }, [gitStatus?.files]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex min-h-full flex-col justify-center px-5 py-8">
        <div className="mx-auto w-full max-w-sm">
          <h2 className="typography-ui-label font-medium text-foreground">{"No file open"}</h2>
          <p className="mt-1 typography-meta text-muted-foreground text-pretty">
            {changed.length > 0
              ? "Pick a file from the tree, or open one the session changed."
              : "Pick a file from the tree to view or edit it."}
          </p>
          {changed.length > 0 ? (
            <section className="mt-4" aria-label={"Changed files"}>
              <h3 className="px-2 typography-micro font-medium text-subtle-foreground">
                {changed.length === 1 ? '1 changed file' : `${changed.length} changed files`}
              </h3>
              <ul className="mt-1 flex flex-col">
                {changed.map(({ path, status }) => {
                  const slash = path.lastIndexOf('/');
                  const name = path.slice(slash + 1);
                  const folder = slash >= 0 ? path.slice(0, slash) : '';
                  return (
                    <li key={path}>
                      <button
                        type="button"
                        onClick={() => void openFile(`${root}/${path}`)}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-interactive-hover/40"
                        title={path}
                      >
                        <FileTypeIcon filePath={path} />
                        <span className={cn('shrink-0 typography-meta text-foreground', fileChangeTextClass(status))}>{name}</span>
                        <span className="min-w-0 flex-1 truncate typography-meta text-subtle-foreground">{folder}</span>
                        <FileChangeMark status={status} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
};
