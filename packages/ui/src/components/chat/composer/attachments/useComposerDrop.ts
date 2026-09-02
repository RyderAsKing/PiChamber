import React from 'react';

import { toast } from '@/components/ui';
import { appendInlineText } from '../text';
import { collectDroppedFiles, hasDraggedFiles } from './dataTransfer';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';

export interface UseComposerDropOptions {
  enabled: boolean;
  composerRef: React.RefObject<ComposerEditorHandle | null>;
  messageRef: React.MutableRefObject<string>;
  cursorPosRef: React.MutableRefObject<number>;
  confirmedMentionsRef: React.MutableRefObject<Set<string>>;
  setMessage: (updater: (prev: string) => string) => void;
  addAttachedFile: (file: File) => Promise<boolean>;
}

export interface UseComposerDropReturn {
  isDragging: boolean;
  isInternalDrag: boolean;
  handleDragEnter: (e: React.DragEvent) => void;
  handleDragOver: (e: React.DragEvent) => void;
  handleDragLeave: (e: React.DragEvent) => void;
  handleDragEnd: () => void;
  handleDrop: (e: React.DragEvent) => Promise<void>;
  handleDropCapture: (e: React.DragEvent) => void;
}

export function useComposerDrop({
  enabled,
  composerRef,
  messageRef,
  cursorPosRef,
  confirmedMentionsRef,
  setMessage,
  addAttachedFile,
}: UseComposerDropOptions): UseComposerDropReturn {
  const [isDragging, setIsDragging] = React.useState(false);
  const [isInternalDrag, setIsInternalDrag] = React.useState(false);
  const dragEnterCountRef = React.useRef(0);

  const handleDragEnter = React.useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    dragEnterCountRef.current++;
    const isInternal = e.dataTransfer.types?.includes('application/x-pichamber-file-path') ?? false;
    if (isInternal !== isInternalDrag) {
      setIsInternalDrag(isInternal);
    }
    if (enabled && !isDragging) {
      setIsDragging(true);
    }
  }, [enabled, isDragging, isInternalDrag]);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (enabled && !isDragging) {
      setIsDragging(true);
    }
  }, [enabled, isDragging]);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragEnterCountRef.current--;
    if (dragEnterCountRef.current <= 0) {
      dragEnterCountRef.current = 0;
      setIsDragging(false);
      setIsInternalDrag(false);
    }
  }, []);

  const handleDragEnd = React.useCallback(() => {
    dragEnterCountRef.current = 0;
    setIsDragging(false);
    setIsInternalDrag(false);
  }, []);

  const handleDrop = React.useCallback(async (e: React.DragEvent) => {
    dragEnterCountRef.current = 0;
    const draggedFiles = hasDraggedFiles(e.dataTransfer);
    if (!draggedFiles) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (!enabled) return;

    // Internal drag: file tree → chat input (relative path as @mention)
    const internalPath = e.dataTransfer.getData('application/x-pichamber-file-path');
    if (internalPath && internalPath !== '.') {
      confirmedMentionsRef.current.add(internalPath);
      const mention = `@${internalPath}`;
      const textarea = composerRef.current;
      const currentMessage = messageRef.current;
      if (textarea) {
        const { start: pos, end } = textarea.getSelection();
        const before = currentMessage.slice(0, pos);
        const after = currentMessage.slice(end);
        const needSpaceBefore = before.length > 0 && !/\s$/.test(before);
        const needSpaceAfter = after.length > 0 && !/^\s/.test(after);
        const insert = `${needSpaceBefore ? ' ' : ''}${mention}${needSpaceAfter ? ' ' : ''}`;
        textarea.replaceRange(pos, end, insert);
        cursorPosRef.current = pos + insert.length;
        textarea.focus();
      } else {
        setMessage((prev) => appendInlineText(prev, mention));
      }
      return;
    }

    const files = collectDroppedFiles(e.dataTransfer);

    if (files.length > 0) {
      const results = await Promise.all(files.map(async (file) => {
        try {
          return await addAttachedFile(file);
        } catch (error) {
          console.error('File attach failed', error);
          return false;
        }
      }));
      if (!results.some(Boolean)) toast.error("Failed to attach file");
    }
  }, [addAttachedFile, composerRef, confirmedMentionsRef, cursorPosRef, enabled, messageRef, setMessage]);

  const handleDropCapture = React.useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) {
      return;
    }
    // Prevent native textarea drop text insertion for all runtimes
    e.preventDefault();
  }, []);

  return {
    isDragging,
    isInternalDrag,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDragEnd,
    handleDrop,
    handleDropCapture,
  };
}
