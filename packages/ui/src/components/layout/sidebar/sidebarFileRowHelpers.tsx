import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';

export type { FileStatus } from '@/components/views/files/fileChange';

export const getFileIcon = (filePath: string, extension?: string): React.ReactNode => {
  return <FileTypeIcon filePath={filePath} extension={extension} />;
};
