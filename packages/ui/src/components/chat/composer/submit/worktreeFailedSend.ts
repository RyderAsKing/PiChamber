/**
 * Failed worktree-send recovery.
 *
 * A new-worktree send clears the submitted prompt from the generic composer
 * slot and rotates the draft id before awaiting creation. When creation fails
 * in the ordinary background path the submitted draft is no longer current,
 * so the prompt/mentions/attachment snapshot would be dropped. The creation
 * store retains that snapshot in task-owned memory (`failedSend`) until the
 * user explicitly restores or dismisses it.
 *
 * Recovery ownership lives here so `BackgroundTasksMenu` stays thin. The menu
 * calls `restoreWorktreeFailedSend`; same-directory restores defer text work
 * to the composer via `pendingWorktreeRestore` so unsaved in-memory text is
 * never overwritten. Different-directory restores open the target draft first
 * (stashing the outgoing draft under its own key) and then write the target
 * slot before the composer's identity-switch effect loads it.
 *
 * Retained snapshots are memory-only: `File` handles and data URLs are never
 * written to `localStorage`. Dismiss and runtime reset delete the entry and
 * release the snapshot. Expired upload ids remain refreshable through the
 * retained `dataUrl` fallback (`routeMessage` refresh branch); restore uses
 * the existing missing-ID append (`restoreAttachmentsForRetry`) and never
 * deletes newer draft files.
 */

import { createChatDraftIdentity, getChatDraftIdentityKey, readChatDraft, writeChatDraft } from '@/lib/chatDraftPersistence';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useWorktreeCreationStore } from '@/stores/useWorktreeCreationStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useInputStore, type PendingWorktreeRestore } from '@/sync/input-store';

type WorktreeRestoreReason =
  | 'missing'
  | 'runtime-mismatch'
  | 'invalid-target'
  | 'target-occupied'
  | 'open-failed'
  | 'pending'
  | 'dismissed'
  | 'navigated-away';

type WorktreeRestoreResult = {
  ok: boolean;
  reason?: WorktreeRestoreReason;
};

const resolveCurrentDraftKey = (): string | null => {
  try {
    const sessionState = useSessionUIStore.getState();
    const newSessionDirectory = sessionState.newSessionDraft?.open
      ? sessionState.newSessionDraft.directoryOverride
      : null;
    const currentSessionId = sessionState.currentSessionId;
    const directory = currentSessionId
      ? (sessionState.getDirectoryForSession(currentSessionId) ?? sessionState.currentSessionDirectory)
      : (newSessionDirectory ?? useDirectoryStore.getState().currentDirectory);
    const identity = createChatDraftIdentity(getRuntimeKey(), directory, currentSessionId);
    return identity ? getChatDraftIdentityKey(identity) : null;
  } catch {
    return null;
  }
};

/**
 * Explicit user action to restore a failed worktree send into a new-session
 * draft targeting the original source directory and worktree intent.
 *
 * Never restores into the wrong runtime: a runtime mismatch keeps the record
 * and reports failure. Never overwrites persisted target text: an occupied
 * target keeps the record. Attachments restore via missing-ID append and
 * never delete newer files.
 */
export const restoreWorktreeFailedSend = (entryKey: string): WorktreeRestoreResult => {
  const store = useWorktreeCreationStore.getState();
  const entry = store.getEntryByKey(entryKey);
  const failedSend = entry?.failedSend;
  if (!entry || !failedSend) return { ok: false, reason: 'missing' };
  if (entry.intent.runtimeKey !== getRuntimeKey()) return { ok: false, reason: 'runtime-mismatch' };

  const targetIdentity = createChatDraftIdentity(getRuntimeKey(), entry.intent.sourceDirectory, null);
  if (!targetIdentity) return { ok: false, reason: 'invalid-target' };
  const targetKey = getChatDraftIdentityKey(targetIdentity);

  // Never overwrite persisted newer text. Attachments are append-safe via
  // missing-ID restore, so they do not block here.
  try {
    const persisted = readChatDraft(targetIdentity);
    if (persisted.text.trim().length > 0 && persisted.text !== failedSend.prompt) {
      return { ok: false, reason: 'target-occupied' };
    }
  } catch {
    return { ok: false, reason: 'invalid-target' };
  }

  const currentKey = resolveCurrentDraftKey();
  const isSameDraft = currentKey !== null && currentKey === targetKey;

  if (isSameDraft) {
    // Same identity: no switch effect will load persisted text, and unsaved
    // in-memory text is invisible here. Defer mutation to the composer, which
    // checks its live message before applying. Keep the record until then.
    // Carry the exact failed payload as the ownership token so the deferred
    // apply consumes only this generation and never a newer retry/completion.
    try {
      useSessionUIStore.getState().openNewSessionDraft({
        directoryOverride: entry.intent.sourceDirectory,
        worktreeIntent: entry.intent,
      });
    } catch {
      return { ok: false, reason: 'open-failed' };
    }
    const pending: PendingWorktreeRestore = {
      entryKey,
      prompt: failedSend.prompt,
      confirmedMentions: [...failedSend.confirmedMentions],
      targetKey,
      attachments: failedSend.attachments.map((file) => ({
        ...file,
        previewUrl: undefined,
        uploadState: file.uploadState ? ({ ...file.uploadState } as typeof file.uploadState) : file.uploadState,
      })),
      expectedFailedSend: failedSend,
    };
    try {
      useInputStore.getState().requestWorktreeRestore(pending);
    } catch {
      return { ok: false, reason: 'open-failed' };
    }
    return { ok: true, reason: 'pending' };
  }

  // Different identity: open first so the switch effect stashes the outgoing
  // draft's unsaved text under its own key, then write the target slot before
  // that effect loads it. Re-check ownership before mutating so a newer
  // in-flight/completed generation under the same key is never overwritten.
  // The final consume is guarded to the exact payload read above.
  const liveBeforeWrite = store.getEntryByKey(entryKey);
  if (!liveBeforeWrite || liveBeforeWrite.failedSend !== failedSend) {
    return { ok: false, reason: 'missing' };
  }
  try {
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: entry.intent.sourceDirectory,
      worktreeIntent: entry.intent,
    });
  } catch {
    return { ok: false, reason: 'open-failed' };
  }

  try {
    writeChatDraft(targetIdentity, failedSend.prompt, failedSend.confirmedMentions);
  } catch {
    return { ok: false, reason: 'invalid-target' };
  }

  try {
    useInputStore.getState().activateAttachmentsDraft(targetKey);
    useInputStore.getState().restoreAttachmentsForRetry(failedSend.attachments);
  } catch {
    // Persisted text is already restored; keep the record so attachments can
    // be retried via the menu rather than dropping the task.
    return { ok: false, reason: 'open-failed' };
  }

  // Restore-once with ownership: consume only the same failed payload read
  // above. A newer in-flight/completed/re-failed generation under the same
  // key keeps its record when the guard refuses.
  try {
    const consumed = store.consumeFailedSend(entryKey, failedSend);
    if (!consumed) return { ok: false, reason: 'missing' };
  } catch {
    // The draft is already restored; a failed consume only risks a duplicate
    // button, not data loss.
    return { ok: true };
  }
  return { ok: true };
};

/**
 * Composer-side application for same-directory pending restores. Checks live
 * in-memory text plus persisted state before mutating, so newer drafts win.
 * Called from `ChatInput`; exported for deterministic module-seam tests.
 */
export const applyPendingWorktreeRestore = (
  pending: PendingWorktreeRestore,
  currentMessageText: string,
): WorktreeRestoreResult => {
  const store = useWorktreeCreationStore.getState();
  const entry = store.getEntryByKey(pending.entryKey);
  const failedSend = entry?.failedSend;
  if (!entry || !failedSend) return { ok: false, reason: 'dismissed' };
  // Ownership: the deferred pending carries the exact payload read at
  // restore time. A newer retry/completion under the same key has a different
  // identity and must be preserved; drop this stale pending without clearing.
  if (failedSend !== pending.expectedFailedSend) return { ok: false, reason: 'dismissed' };
  if (entry.intent.runtimeKey !== getRuntimeKey()) return { ok: false, reason: 'runtime-mismatch' };

  const targetIdentity = createChatDraftIdentity(getRuntimeKey(), entry.intent.sourceDirectory, null);
  if (!targetIdentity) return { ok: false, reason: 'invalid-target' };
  const targetKey = getChatDraftIdentityKey(targetIdentity);
  if (targetKey !== pending.targetKey) return { ok: false, reason: 'invalid-target' };

  const currentKey = resolveCurrentDraftKey();
  if (currentKey !== null && currentKey !== targetKey) return { ok: false, reason: 'navigated-away' };

  const liveText = currentMessageText ?? '';
  if (liveText.trim().length > 0 && liveText !== pending.prompt) {
    return { ok: false, reason: 'target-occupied' };
  }

  try {
    const persisted = readChatDraft(targetIdentity);
    if (persisted.text.trim().length > 0 && persisted.text !== pending.prompt) {
      return { ok: false, reason: 'target-occupied' };
    }
  } catch {
    return { ok: false, reason: 'invalid-target' };
  }

  // Source directory sanity: the restored draft must target the original
  // checkout scope, never the currently focused unrelated directory.
  const normalizedSource = normalizePath(entry.intent.sourceDirectory);
  const normalizedTargetDir = normalizePath(targetIdentity.directory);
  if (!normalizedSource || normalizedSource !== normalizedTargetDir) {
    return { ok: false, reason: 'invalid-target' };
  }

  try {
    writeChatDraft(targetIdentity, pending.prompt, pending.confirmedMentions);
    useInputStore.getState().activateAttachmentsDraft(targetKey);
    useInputStore.getState().restoreAttachmentsForRetry(pending.attachments);
  } catch {
    return { ok: false, reason: 'open-failed' };
  }

  try {
    const consumed = store.consumeFailedSend(pending.entryKey, failedSend);
    if (!consumed) return { ok: false, reason: 'dismissed' };
  } catch {
    // Restored; consume failure only risks a stale button.
    return { ok: true };
  }
  return { ok: true };
};
