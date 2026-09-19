import type { AttachedFile } from '@/stores/types/sessionTypes';

/**
 * Clone an attachment for ownership handoff or recovery.
 *
 * File bytes are immutable and may remain shared. Mutable wrapper state is
 * copied, while the revocable preview URL is dropped so a retained snapshot
 * never depends on the visible draft's browser resource lifecycle.
 */
export const cloneAttachmentSnapshot = (file: AttachedFile): AttachedFile => ({
  ...file,
  previewUrl: undefined,
  uploadState: file.uploadState
    ? ({ ...file.uploadState } as AttachedFile['uploadState'])
    : file.uploadState,
});
