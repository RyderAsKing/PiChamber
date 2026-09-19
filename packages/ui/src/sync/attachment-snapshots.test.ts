import { expect, test } from 'bun:test';

import type { AttachedFile } from '@/stores/types/sessionTypes';
import { cloneAttachmentSnapshot } from './attachment-snapshots';

test('attachment snapshots drop preview resources and isolate mutable upload state', () => {
  const source: AttachedFile = {
    id: 'attachment-a',
    file: new File(['payload'], 'a.txt', { type: 'text/plain' }),
    dataUrl: 'data:text/plain;base64,cGF5bG9hZA==',
    mimeType: 'text/plain',
    filename: 'a.txt',
    size: 7,
    source: 'local',
    previewUrl: 'blob:preview-a',
    uploadState: {
      status: 'ready',
      attachmentId: 'opaque-a',
      expiresAt: Date.now() + 60_000,
    },
  };

  const snapshot = cloneAttachmentSnapshot(source);

  expect(snapshot).not.toBe(source);
  expect(snapshot.file).toBe(source.file);
  expect(snapshot.previewUrl).toBeUndefined();
  expect(snapshot.uploadState).not.toBe(source.uploadState);
  expect(snapshot.uploadState).toEqual(source.uploadState);
});
