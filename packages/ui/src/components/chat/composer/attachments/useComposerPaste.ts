import React from 'react';

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

      // Pasting a URL over a selection wraps it as a markdown link:
      // [selected text](pasted url).
      if (inputMode === 'normal' && enabled) {
        const ta = composerRef.current;
        const selStart = ta?.getSelection().start ?? -1;
        const selEnd = ta?.getSelection().end ?? -1;
        if (ta && selEnd > selStart) {
          const clipboardText = e.clipboardData.getData('text');
          const url = clipboardText.trim();
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
      const pastedText = e.clipboardData.getData('text');
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

      const assignedFilenames = assignImageAttachmentFilenames(imageFiles, [
        ...attachedFiles.map((file) => file.filename),
        ...pendingPastedAttachmentFilenamesRef.current,
      ]);
      const citationText = buildAttachmentCitationText(assignedFilenames);
      const textarea = composerRef.current;
      const selectionStart = textarea?.getSelection().start ?? message.length;
      const selectionEnd = textarea?.getSelection().end ?? message.length;
      const insertionText = withInlineInsertionBoundaries(
        buildImagePasteInsertion(pastedText, citationText),
        message.slice(0, selectionStart),
        message.slice(selectionEnd)
      );

      insertTextAtSelection(insertionText, getFileMentionInputSourceForInsertedText(insertionText));

      await Promise.all(
        imageFiles.map(async (imageFile, index) => {
          const filename = assignedFilenames[index];
          const file = renameFileForAttachmentCitation(imageFile, filename);
          pendingPastedAttachmentFilenamesRef.current.add(filename);
          try {
            await addAttachedFile(file);
          } catch (error) {
            console.error('Clipboard image attach failed', error);
            toast.error(
              error instanceof Error ? error.message : 'Failed to attach image from clipboard'
            );
          } finally {
            pendingPastedAttachmentFilenamesRef.current.delete(filename);
          }
        })
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
