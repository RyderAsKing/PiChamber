export type FilesystemErrorReason =
  | 'os-permission'
  | 'not-found'
  | 'not-directory'
  | 'invalid-response'
  | 'file-revision-conflict'
  | 'unknown';

export class FilesystemError extends Error {
  readonly reason: FilesystemErrorReason;
  readonly status?: number;

  constructor(message: string, options: { reason?: FilesystemErrorReason; status?: number } = {}) {
    super(message);
    this.name = 'FilesystemError';
    this.reason = options.reason ?? 'unknown';
    this.status = options.status;
  }
}

/** Typed save conflict carrying the current server revision (finding #8). */
export class FileRevisionConflictError extends FilesystemError {
  readonly currentRevision: string | null;
  readonly exists: boolean;
  readonly filePath: string;

  constructor(message: string, options: {
    currentRevision?: string | null;
    exists?: boolean;
    path?: string;
    status?: number;
  } = {}) {
    super(message, { reason: 'file-revision-conflict', status: options.status ?? 409 });
    this.name = 'FileRevisionConflictError';
    this.currentRevision = options.currentRevision ?? null;
    this.exists = options.exists ?? (options.currentRevision != null);
    this.filePath = options.path ?? '';
  }
}

export const isFileRevisionConflict = (error: unknown): error is FileRevisionConflictError => (
  error instanceof FileRevisionConflictError
  || (isFilesystemError(error) && error.reason === 'file-revision-conflict')
);

export const isFilesystemError = (error: unknown): error is FilesystemError => (
  error instanceof FilesystemError
  || Boolean(
    error
    && typeof error === 'object'
    && 'reason' in error
    && typeof (error as { reason?: unknown }).reason === 'string'
  )
);

export const parseFilesystemErrorReason = (value: unknown): FilesystemErrorReason => {
  switch (value) {
    case 'os-permission':
    case 'not-found':
    case 'not-directory':
    case 'invalid-response':
    case 'file-revision-conflict':
      return value;
    default:
      return 'unknown';
  }
};
