import React from 'react';

import type { ComposerEditorHandle } from '../editor/ComposerEditor';
import type { CommandInfo } from '../../CommandAutocomplete';

export interface UseComposerAutocompleteHandlersOptions {
  composerRef: React.RefObject<ComposerEditorHandle | null>;
  message: string;
  setMessage: (message: string) => void;
  updateAutocompleteState: (text: string, cursor: number) => void;
  closeAutocomplete: () => void;
  confirmedMentionsRef: React.MutableRefObject<Set<string>>;
  toMentionPath: (filePath: string) => string;
}

export interface UseComposerAutocompleteHandlersReturn {
  handleFileSelect: (file: { name: string; path: string; relativePath?: string }) => void;
  handleAgentSelect: (agentName: string) => void;
  handleSkillSelect: (skillName: string) => void;
  handleSnippetSelect: (_snippet: unknown, trigger: string) => void;
  handleCommandSelect: (command: CommandInfo) => void;
}

export function buildFileMentionReplacement(
  message: string,
  cursorPosition: number,
  mentionPath: string
): { newMessage: string; nextCursor: number } {
  const textBeforeCursor = message.substring(0, cursorPosition);
  const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

  if (lastAtSymbol !== -1) {
    const newMessage =
      message.substring(0, lastAtSymbol) +
      `@${mentionPath} ` +
      message.substring(cursorPosition);
    const nextCursor = lastAtSymbol + mentionPath.length + 2;
    return { newMessage, nextCursor };
  }

  const newMessage =
    message.substring(0, cursorPosition) +
    `@${mentionPath} ` +
    message.substring(cursorPosition);
  const nextCursor = cursorPosition + mentionPath.length + 2;
  return { newMessage, nextCursor };
}

export function buildPrefixTokenReplacement(
  message: string,
  cursorPosition: number,
  prefix: '@' | '/' | '#',
  token: string
): { newMessage: string; nextCursor: number } {
  const textBeforeCursor = message.substring(0, cursorPosition);
  const lastSymbol = textBeforeCursor.lastIndexOf(prefix);
  const startIndex = lastSymbol !== -1 ? lastSymbol : cursorPosition;
  const newMessage = `${message.substring(0, startIndex)}${prefix}${token} ${message.substring(cursorPosition)}`;
  const nextCursor = startIndex + token.length + 2;
  return { newMessage, nextCursor };
}

export function useComposerAutocompleteHandlers({
  composerRef,
  message,
  setMessage,
  updateAutocompleteState,
  closeAutocomplete,
  confirmedMentionsRef,
  toMentionPath,
}: UseComposerAutocompleteHandlersOptions): UseComposerAutocompleteHandlersReturn {
  const handleFileSelect = React.useCallback(
    (file: { name: string; path: string; relativePath?: string }) => {
      const cursorPosition = composerRef.current?.getSelection().start || 0;
      const mentionPath =
        file.relativePath && file.relativePath.trim().length > 0
          ? file.relativePath.trim()
          : toMentionPath(file.path) || file.name;

      confirmedMentionsRef.current.add(mentionPath);

      const { newMessage, nextCursor } = buildFileMentionReplacement(
        message,
        cursorPosition,
        mentionPath
      );
      setMessage(newMessage);
      requestAnimationFrame(() => {
        if (composerRef.current) {
          composerRef.current.setSelection(nextCursor);
        }
        updateAutocompleteState(newMessage, nextCursor);
      });

      closeAutocomplete();
      composerRef.current?.focus();
    },
    [closeAutocomplete, composerRef, confirmedMentionsRef, message, setMessage, toMentionPath, updateAutocompleteState]
  );

  const handleAgentSelect = React.useCallback(
    (agentName: string) => {
      const cursorPosition = composerRef.current?.getSelection().start ?? message.length;
      const { newMessage, nextCursor } = buildPrefixTokenReplacement(
        message,
        cursorPosition,
        '@',
        agentName
      );
      setMessage(newMessage);

      requestAnimationFrame(() => {
        if (composerRef.current) {
          composerRef.current.setSelection(nextCursor);
        }
        updateAutocompleteState(newMessage, nextCursor);
      });

      closeAutocomplete();
      composerRef.current?.focus();
    },
    [closeAutocomplete, composerRef, message, setMessage, updateAutocompleteState]
  );

  const handleSkillSelect = React.useCallback(
    (skillName: string) => {
      // Inline skill picker inserts the native Pi invocation Pi expands
      // (`/skill:name`), never the bare resource name Pi treats as prose.
      const invocation = skillName.startsWith("skill:") ? skillName : `skill:${skillName}`;
      const cursorPosition = composerRef.current?.getSelection().start ?? message.length;
      const { newMessage, nextCursor } = buildPrefixTokenReplacement(
        message,
        cursorPosition,
        '/',
        invocation
      );
      setMessage(newMessage);

      requestAnimationFrame(() => {
        if (composerRef.current) {
          composerRef.current.setSelection(nextCursor);
        }
        updateAutocompleteState(newMessage, nextCursor);
      });

      closeAutocomplete();
      composerRef.current?.focus();
    },
    [closeAutocomplete, composerRef, message, setMessage, updateAutocompleteState]
  );

  const handleSnippetSelect = React.useCallback(
    (_snippet: unknown, trigger: string) => {
      const cursorPosition = composerRef.current?.getSelection().start ?? message.length;
      const { newMessage, nextCursor } = buildPrefixTokenReplacement(
        message,
        cursorPosition,
        '#',
        trigger
      );
      setMessage(newMessage);
      requestAnimationFrame(() => {
        if (composerRef.current) {
          composerRef.current.setSelection(nextCursor);
        }
        updateAutocompleteState(newMessage, nextCursor);
      });
      closeAutocomplete();
      composerRef.current?.focus();
    },
    [closeAutocomplete, composerRef, message, setMessage, updateAutocompleteState]
  );

  const handleCommandSelect = React.useCallback(
    (command: CommandInfo) => {
      // Insert the executable invocation Pi resolves (`review`,
      // `skill:code-review`, or a registered extension name). Keyboard and
      // mouse selection share this path so they produce identical text.
      const invocation = command.invocationName ?? command.name;
      setMessage(`/${invocation} `);
      closeAutocomplete();

      const refocus = () => {
        if (composerRef.current) {
          try {
            composerRef.current.focus({ preventScroll: true });
          } catch {
            composerRef.current.focus();
          }
          composerRef.current.setSelection(
            composerRef.current.getValue().length,
            composerRef.current.getValue().length
          );
        }
      };

      requestAnimationFrame(() => {
        refocus();
        requestAnimationFrame(refocus);
      });
      setTimeout(refocus, 60);
    },
    [closeAutocomplete, composerRef, setMessage]
  );

  return {
    handleFileSelect,
    handleAgentSelect,
    handleSkillSelect,
    handleSnippetSelect,
    handleCommandSelect,
  };
}
