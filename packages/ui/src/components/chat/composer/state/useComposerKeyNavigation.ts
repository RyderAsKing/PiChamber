import React from 'react';

import { isIMECompositionEvent } from '@/lib/ime';
import type { CommandAutocompleteHandle } from '../../CommandAutocomplete';
import type { FileMentionHandle } from '../../FileMentionAutocomplete';
import type { SkillAutocompleteHandle } from '../../SkillAutocomplete';
import type { SnippetAutocompleteHandle } from '../../SnippetAutocomplete';
import type { ComposerEditorHandle } from '../editor/ComposerEditor';

export interface UseComposerKeyNavigationOptions {
  inputMode: 'normal' | 'shell';
  setInputMode: (mode: 'normal' | 'shell') => void;
  message: string;
  setMessage: (message: string) => void;
  openAutocomplete: 'command' | 'skill' | 'snippet' | 'mention' | null;
  commandRef: React.RefObject<CommandAutocompleteHandle | null>;
  skillRef: React.RefObject<SkillAutocompleteHandle | null>;
  snippetRef: React.RefObject<SnippetAutocompleteHandle | null>;
  mentionRef: React.RefObject<FileMentionHandle | null>;
  composerRef: React.RefObject<ComposerEditorHandle | null>;
  messageHistory: { older: (current: string) => string | null; newer: () => string | null };
  updateAutocompleteState: (text: string, cursor: number) => void;
  isMobile: boolean;
  hasContent: boolean;
  currentSessionId: string | null;
  sessionPhase: string;
  followUpBehavior: 'queue' | 'steer';
  handleSubmit: (options?: { delivery?: 'steer' }) => void | Promise<void>;
  handleQueueMessage: () => Promise<void>;
}

export const WRAP_PAIRS: Record<string, [string, string]> = {
  '`': ['`', '`'],
  '*': ['*', '*'],
  _: ['_', '_'],
  '~': ['~', '~'],
  '(': ['(', ')'],
  '[': ['[', ']'],
  '{': ['{', '}'],
  '"': ['"', '"'],
  "'": ["'", "'"],
};

export function tryWrapSelection(
  message: string,
  selStart: number,
  selEnd: number,
  key: string
): { next: string; caretStart: number; caretEnd: number } | null {
  if (selEnd <= selStart) return null;
  const pair = WRAP_PAIRS[key];
  if (!pair) return null;
  const [open, close] = pair;
  const selected = message.slice(selStart, selEnd);
  const next = `${message.slice(0, selStart)}${open}${selected}${close}${message.slice(selEnd)}`;
  return {
    next,
    caretStart: selStart + open.length,
    caretEnd: selEnd + open.length,
  };
}

export function tryExpandFencedCodeBlock(
  message: string,
  selStart: number,
  selEnd: number,
  key: string
): { next: string; caret: number } | null {
  if (key !== '`' || selStart !== selEnd) return null;
  const before = message.slice(0, selStart);
  if (/(^|\n)``$/.test(before)) {
    const after = message.slice(selEnd);
    const next = `${before}\`\n\n\`\`\`${after}`;
    const caret = before.length + 2;
    return { next, caret };
  }
  return null;
}

export function useComposerKeyNavigation({
  inputMode,
  setInputMode,
  message,
  setMessage,
  openAutocomplete,
  commandRef,
  skillRef,
  snippetRef,
  mentionRef,
  composerRef,
  messageHistory,
  updateAutocompleteState,
  isMobile,
  hasContent,
  currentSessionId,
  sessionPhase,
  followUpBehavior,
  handleSubmit,
  handleQueueMessage,
}: UseComposerKeyNavigationOptions): (e: KeyboardEvent) => void {
  return React.useCallback(
    (e: KeyboardEvent) => {
      // Early return during IME composition to prevent interference with autocomplete.
      if (isIMECompositionEvent(e)) return;

      if (inputMode === 'shell' && e.key === 'Escape') {
        e.preventDefault();
        setInputMode('normal');
        return;
      }

      if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
        e.preventDefault();
        setInputMode('normal');
        return;
      }

      if (openAutocomplete === 'command' && commandRef.current) {
        if (
          e.key === 'Enter' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'Escape' ||
          e.key === 'Tab'
        ) {
          e.preventDefault();
          e.stopPropagation();
          commandRef.current.handleKeyDown(e.key);
          return;
        }
      }

      if (openAutocomplete === 'skill' && skillRef.current) {
        if (
          e.key === 'Enter' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'Escape' ||
          e.key === 'Tab'
        ) {
          e.preventDefault();
          e.stopPropagation();
          skillRef.current.handleKeyDown(e.key);
          return;
        }
      }

      if (openAutocomplete === 'snippet' && snippetRef.current) {
        if (
          e.key === 'Enter' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'Escape' ||
          e.key === 'Tab'
        ) {
          e.preventDefault();
          e.stopPropagation();
          snippetRef.current.handleKeyDown(e.key);
          return;
        }
      }

      if (openAutocomplete === 'mention' && mentionRef.current) {
        if (
          e.key === 'Enter' ||
          e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'Escape' ||
          e.key === 'Tab'
        ) {
          e.preventDefault();
          e.stopPropagation();
          mentionRef.current.handleKeyDown(e.key);
          return;
        }
      }

      // Handle ArrowUp/ArrowDown for message history navigation
      const isAnyAutocompleteOpen = openAutocomplete !== null;
      const cursorAtStart =
        composerRef.current?.getSelection().start === 0 &&
        composerRef.current?.getSelection().end === 0;
      const cursorAtEnd =
        composerRef.current?.getSelection().start === message.length &&
        composerRef.current?.getSelection().end === message.length;
      const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
      const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

      // Markdown-aware auto-pairing (source mode), normal input only.
      if (inputMode === 'normal' && !isAnyAutocompleteOpen && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const ta = composerRef.current;
        const selStart = ta?.getSelection().start ?? -1;
        const selEnd = ta?.getSelection().end ?? -1;

        if (ta && selStart >= 0) {
          const applyEdit = (next: string, caretStart: number, caretEnd: number) => {
            e.preventDefault();
            setMessage(next);
            composerRef.current?.setSelection(caretStart, caretEnd);
            updateAutocompleteState(next, caretEnd);
          };

          const wrapResult = tryWrapSelection(message, selStart, selEnd, e.key);
          if (wrapResult) {
            applyEdit(wrapResult.next, wrapResult.caretStart, wrapResult.caretEnd);
            return;
          }

          const expandResult = tryExpandFencedCodeBlock(message, selStart, selEnd, e.key);
          if (expandResult) {
            applyEdit(expandResult.next, expandResult.caret, expandResult.caret);
            return;
          }
        }
      }

      if (e.key === 'ArrowUp' && canNavigateHistoryUp) {
        e.preventDefault();
        const recalled = messageHistory.older(message);
        if (recalled !== null) {
          setMessage(recalled);
          requestAnimationFrame(() => composerRef.current?.setSelection(0, 0));
        }
        return;
      }

      if (e.key === 'ArrowDown' && canNavigateHistoryDown) {
        e.preventDefault();
        const recalled = messageHistory.newer();
        if (recalled !== null) setMessage(recalled);
        return;
      }

      // Handle Enter/Ctrl+Enter based on selected follow-up behavior.
      if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
        e.preventDefault();

        const isCtrlEnter = e.ctrlKey || e.metaKey;
        const canQueue =
          inputMode === 'normal' && hasContent && currentSessionId && sessionPhase !== 'idle';

        if (followUpBehavior === 'queue') {
          if (isCtrlEnter || !canQueue) {
            handleSubmit();
          } else {
            void handleQueueMessage();
          }
        } else {
          // steer: Enter steers into the running turn, Ctrl+Enter sends now.
          if (isCtrlEnter || !canQueue) {
            handleSubmit();
          } else {
            handleSubmit({ delivery: 'steer' });
          }
        }
      }
    },
    [
      commandRef,
      composerRef,
      currentSessionId,
      followUpBehavior,
      handleQueueMessage,
      handleSubmit,
      hasContent,
      inputMode,
      isMobile,
      mentionRef,
      message,
      messageHistory,
      openAutocomplete,
      sessionPhase,
      setInputMode,
      setMessage,
      skillRef,
      snippetRef,
      updateAutocompleteState,
    ]
  );
}
