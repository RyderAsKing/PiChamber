import React from 'react';

import i18n from '@/i18n';
import { toast } from '@/components/ui';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import {
  assignImageAttachmentFilenames,
  buildAttachmentCitationText,
  renameFileForAttachmentCitation,
} from '../../attachmentCitations';
import {
  getFileMentionInputSourceForInsertedText,
  type FileMentionAutocompleteInputSource,
} from '../../fileMentionAutocompleteState';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';
import {
  buildImagePasteInsertion,
  shouldWrapSelectionAsLink,
  withInlineInsertionBoundaries,
} from '../text';

export interface UseComposerPasteOptions {
  inputMode: 'normal' | 'shell';
  enabled: boolean;
  composerRef: React.RefObject<ComposerEditorHandle | null>;
  message: string;
  setMessage: (message: string) => void;
  insertTextAtSelection: (text: string, inputSource: FileMentionAutocompleteInputSource) => void;
  updateAutocompleteState: (
    text: string,
    cursor: number,
    inputSource: FileMentionAutocompleteInputSource,
    insertedText?: string
  ) => void;
  markFileMentionPasteSuppression: () => void;
  attachedFiles: AttachedFile[];
  addAttachedFile: (file: File) => Promise<boolean>;
}

/**
 * Oversized plain-text paste becomes a `.txt` attachment instead of inline text.
 *
 * Explicit documented threshold: 16,000 UTF-16 code units (`String.length`).
 * Ordinary pastes at or below the threshold keep existing native semantics.
 * No root cause for any downstream truncation is established here; this is a
 * deliberate product boundary, not a diagnosis.
 *
 * Performance contract (operation counts, no new dependencies):
 * - O(1) threshold decision (`length` property read).
 * - Zero editor insertion for oversized text (no `insertTextAtSelection`,
 *   `setMessage`, or `updateAutocompleteState` for the pasted payload).
 * - One attachment enqueue for pure-text oversized paste
 *   (`addAttachedFile` once); mixed image+text enqueues one text file plus
 *   the existing per-image enqueues.
 * - No ongoing work after the enqueue settles (no timers, observers, or
 *   retries owned here).
 */
export const OVERSIZED_PASTE_TEXT_THRESHOLD = 16_000;
export const OVERSIZED_PASTE_FILENAME = 'pasted-text.txt';

export function isOversizedPastedText(text: string): boolean {
  return text.length > OVERSIZED_PASTE_TEXT_THRESHOLD;
}

export function createOversizedPastedTextFile(text: string): File {
  return new File([text], OVERSIZED_PASTE_FILENAME, { type: 'text/plain' });
}

export function useComposerPaste({
  inputMode,
  enabled,
  composerRef,
  message,
  setMessage,
  insertTextAtSelection,
  updateAutocompleteState,
  markFileMentionPasteSuppression,
  attachedFiles,
  addAttachedFile,
}: UseComposerPasteOptions): (event: ClipboardEvent) => Promise<void> {
  const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());

  return React.useCallback(
    async (event: ClipboardEvent) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return;
      const e = { ...event, clipboardData, preventDefault: () => event.preventDefault() };
      // Read clipboard text once: URL wrapping and the oversized threshold
      // share this value so an oversized URL cannot bypass the attachment path.
      const pastedText = e.clipboardData.getData('text');
      const oversizedPastedText = isOversizedPastedText(pastedText);

      // Pasting a URL over a selection wraps it as a markdown link:
      // [selected text](pasted url). Oversized text is excluded here and
      // falls through to the .txt attachment path below.
      if (inputMode === 'normal' && enabled && !oversizedPastedText) {
        const ta = composerRef.current;
        const selStart = ta?.getSelection().start ?? -1;
        const selEnd = ta?.getSelection().end ?? -1;
        if (ta && selEnd > selStart) {
          const url = pastedText.trim();
          const selected = message.slice(selStart, selEnd);
          if (shouldWrapSelectionAsLink(url, selected)) {
            e.preventDefault();
            const next = `${message.slice(0, selStart)}[${selected}](${url})${message.slice(selEnd)}`;
            const caret = selStart + 1 + selected.length + 2 + url.length + 1;
            setMessage(next);
            composerRef.current?.setSelection(caret, caret);
            updateAutocompleteState(next, caret, getFileMentionInputSourceForInsertedText(url), url);
            return;
          }
        }
      }

      const fileMap = new Map<string, File>();

      Array.from(e.clipboardData.files || []).forEach((file) => {
        if (file.type.startsWith('image/')) {
          fileMap.set(`${file.name}-${file.size}`, file);
        }
      });

      Array.from(e.clipboardData.items || []).forEach((item) => {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            fileMap.set(`${file.name}-${file.size}`, file);
          }
        }
      });

      const imageFiles = Array.from(fileMap.values());

      // Oversized plain-text paste -> .txt attachment. Prevent default
      // synchronously (before any await) so the native insertion never runs.
      // Ordinary pastes at or below the threshold fall through unchanged.
      // Read-only/disabled composers keep existing behavior: no interception.
      // Oversized URLs are excluded from link wrapping above and take this
      // same attachment path. Mixed image plus oversized text falls through
      // to the shared image flow below with empty inline text.
      if (oversizedPastedText) {
        if (!enabled) {
          if (pastedText.includes('@')) {
            markFileMentionPasteSuppression();
          }
          return;
        }

        e.preventDefault();

        if (imageFiles.length === 0) {
          const file = createOversizedPastedTextFile(pastedText);
          try {
            const attached = await addAttachedFile(file);
            if (!attached) {
              toast.error(i18n.t('Failed to attach pasted text as file'));
            }
          } catch {
            toast.error(i18n.t('Failed to attach pasted text as file'));
          }
          return;
        }
      } else {
        if (imageFiles.length === 0) {
          if (pastedText.includes('@')) {
            markFileMentionPasteSuppression();
          }
          return;
        }

        if (!enabled) {
          if (pastedText.includes('@')) {
            markFileMentionPasteSuppression();
          }
          return;
        }

        e.preventDefault();
      }

      const assignedFilenames = assignImageAttachmentFilenames(imageFiles, [
        ...attachedFiles.map((file) => file.filename),
        ...pendingPastedAttachmentFilenamesRef.current,
      ]);
      const citationText = buildAttachmentCitationText(assignedFilenames);
      const textarea = composerRef.current;
      const selectionStart = textarea?.getSelection().start ?? message.length;
      const selectionEnd = textarea?.getSelection().end ?? message.length;
      const insertionText = withInlineInsertionBoundaries(
        buildImagePasteInsertion(oversizedPastedText ? '' : pastedText, citationText),
        message.slice(0, selectionStart),
        message.slice(selectionEnd)
      );

      insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));

      const attachOversizedText = oversizedPastedText
        ? (async () => {
            try {
              const attached = await addAttachedFile(
                createOversizedPastedTextFile(pastedText)
              );
              if (!attached) {
                toast.error(i18n.t('Failed to attach pasted text as file'));
              }
            } catch {
              toast.error(i18n.t('Failed to attach pasted text as file'));
            }
          })()
        : null;

      const attachImages = imageFiles.map(async (imageFile, index) => {
        const filename = assignedFilenames[index];
        const file = renameFileForAttachmentCitation(imageFile, filename);
        pendingPastedAttachmentFilenamesRef.current.add(filename);
        try {
          await addAttachedFile(file);
        } catch (error) {
          console.error('Clipboard image attach failed', error);
          toast.error(
            error instanceof Error ? error.message : i18n.t('Failed to attach image from clipboard')
          );
        } finally {
          pendingPastedAttachmentFilenamesRef.current.delete(filename);
        }
      });
      await Promise.all(
        attachOversizedText ? [attachOversizedText, ...attachImages] : attachImages
      );
    },
    [
      addAttachedFile,
      attachedFiles,
      composerRef,
      enabled,
      inputMode,
      insertTextAtSelection,
      markFileMentionPasteSuppression,
      message,
      setMessage,
      updateAutocompleteState,
    ]
  );
}
