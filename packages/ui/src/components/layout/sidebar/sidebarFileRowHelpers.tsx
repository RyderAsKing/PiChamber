import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';

export type FileStatus = 'open' | 'modified' | 'git-modified' | 'git-added' | 'git-deleted';

export const getFileIcon = (filePath: string, extension?: string): React.ReactNode => {
  return <FileTypeIcon filePath={filePath} extension={extension} />;
};
