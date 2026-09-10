import { describe, expect, test } from 'bun:test';

import {
  FileRevisionConflictError,
  FilesystemError,
  isFileRevisionConflict,
  parseFilesystemErrorReason,
} from '@/lib/api/files-errors';

describe('file revision conflict errors', () => {
  test('carries typed conflict details for explicit overwrite workflows', () => {
    const error = new FileRevisionConflictError('File has changed on disk', {
      currentRevision: 'v1:8:2000:def',
      exists: true,
      path: '/repo/a.txt',
    });
    expect(error).toBeInstanceOf(FilesystemError);
    expect(error.reason).toBe('file-revision-conflict');
    expect(error.status).toBe(409);
    expect(error.currentRevision).toBe('v1:8:2000:def');
    expect(error.exists).toBe(true);
    expect(error.filePath).toBe('/repo/a.txt');
    expect(isFileRevisionConflict(error)).toBe(true);
  });

  test('represents deleted files with null revision', () => {
    const error = new FileRevisionConflictError('File has changed on disk', {
      currentRevision: null,
      exists: false,
      path: '/repo/gone.txt',
    });
    expect(error.exists).toBe(false);
    expect(error.currentRevision).toBeNull();
    expect(isFileRevisionConflict(error)).toBe(true);
  });

  test('rejects non-conflict errors', () => {
    expect(isFileRevisionConflict(new FilesystemError('nope', { reason: 'unknown' }))).toBe(false);
    expect(isFileRevisionConflict(new Error('nope'))).toBe(false);
  });

  test('parses the conflict reason from wire payloads', () => {
    expect(parseFilesystemErrorReason('file-revision-conflict')).toBe('file-revision-conflict');
    expect(parseFilesystemErrorReason('os-permission')).toBe('os-permission');
    expect(parseFilesystemErrorReason('bogus')).toBe('unknown');
  });
});
