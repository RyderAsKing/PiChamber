/**
 * Worktree-send attachment handoff.
 *
 * A new-worktree send awaits worktree creation while the composer resets to a
 * fresh draft, so prompt dispatch after setup-ready must use the files
 * captured before that await — never mutable visible draft state. Local bytes
 * are retained up front so an upload ID that expires during the long setup
 * can still be refreshed at dispatch (uploaded local files carry
 * `dataUrl: ""`); when those bytes are unavailable the capture rejects and
 * the send aborts before the draft switches.
 *
 * The snapshot is immutable: every entry is cloned (including its
 * `uploadState`) and ephemeral preview object URLs are stripped, so later
 * live-draft mutations cannot reach the pending send and the snapshot never
 * retains a revocable browser URL. Dispatch previews fall back to the
 * retained `dataUrl`.
 */

import { serializeAttachmentsForQueue } from "@/sync/input-store";
import type { AttachedFile } from "@/stores/types/sessionTypes";

/**
 * Clone one entry for capture. The `File` handle is shared (bytes are
 * immutable); the wrapper and its `uploadState` are fresh objects and the
 * ephemeral preview URL is dropped (dispatch previews use `dataUrl`).
 */
const cloneHandoffFile = (file: AttachedFile): AttachedFile => ({
  ...file,
  previewUrl: undefined,
  uploadState: file.uploadState
    ? ({ ...file.uploadState } as AttachedFile["uploadState"])
    : file.uploadState,
});

/**
 * Freeze the pending send's file list and retain a usable byte fallback for
 * every local file. Rejects when a local file's bytes are unavailable.
 */
export const captureWorktreeAttachments = async (
  files: readonly AttachedFile[],
): Promise<AttachedFile[]> => {
  const serialized = await serializeAttachmentsForQueue([...files]);
  return serialized.map(cloneHandoffFile);
};

/**
 * Resolve the files a post-await dispatch must send. A captured snapshot
 * always wins over live draft state; without one (normal sends) the live
 * list is used unchanged.
 */
export const resolveWorktreeSendAttachments = (
  captured: readonly AttachedFile[] | null,
  live: readonly AttachedFile[],
): readonly AttachedFile[] => captured ?? live;

/**
 * Detach scope for a settled dispatch: only the ids the send captured, so a
 * successful worktree send never deletes files added to a newer draft while
 * the worktree was building.
 */
export const worktreeSendAttachmentIds = (
  captured: readonly AttachedFile[] | null,
  live: readonly AttachedFile[],
): string[] => (captured ?? live).map((file) => file.id);
