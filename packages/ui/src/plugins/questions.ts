import React from 'react';

import { choiceAnswer, respondToExtensionDialog } from '@/components/chat/extensionDialogRespond';
import type { PiExtensionDialogPayload } from '@/lib/pi/protocol';
import type { PluginQuestion } from './types';

/** A session's pending questions that name a tool call, in arrival order. */
export const selectToolQuestions = (
  dialogs: readonly PiExtensionDialogPayload[] | undefined,
): PiExtensionDialogPayload[] => (dialogs ?? []).filter((dialog) => (
  dialog.method === 'choose'
  && typeof dialog.toolCallId === 'string'
  && dialog.toolCallId.length > 0
  && Array.isArray(dialog.choices)
  && dialog.choices.length > 0
));

/** Same questions in the same order: nothing a component draws changed. */
export const sameToolQuestions = (
  left: readonly PiExtensionDialogPayload[],
  right: readonly PiExtensionDialogPayload[],
): boolean => left.length === right.length && left.every((dialog, index) => dialog === right[index]);

/** The question a tool call waits on, with the calls that answer it. */
export const toPluginQuestion = (sessionId: string, dialog: PiExtensionDialogPayload): PluginQuestion => ({
  requestId: dialog.requestId,
  title: dialog.title,
  ...(dialog.message ? { message: dialog.message } : {}),
  choices: dialog.choices ?? [],
  allowNote: dialog.allowNote === true,
  answer: (choiceId, note) => respondToExtensionDialog(
    sessionId,
    dialog.requestId,
    choiceAnswer(choiceId, dialog.allowNote === true ? note : ''),
  ),
  dismiss: () => respondToExtensionDialog(sessionId, dialog.requestId, { cancelled: true }),
});

// Questions a plugin component is drawing in the chat right now, by request
// id (a count, since a turn can be mounted twice for a moment). The dock
// above the composer reads this to fold itself to one line: the same
// question is then answered where its options are shown.
const drawnQuestions = new Map<string, number>();
const drawnListeners = new Set<() => void>();
const notifyDrawn = () => drawnListeners.forEach((listener) => listener());
const subscribeDrawn = (listener: () => void) => {
  drawnListeners.add(listener);
  return () => { drawnListeners.delete(listener); };
};

/** Record that a mounted component draws this question. Returns the undo. */
export const markQuestionDrawn = (requestId: string): (() => void) => {
  drawnQuestions.set(requestId, (drawnQuestions.get(requestId) ?? 0) + 1);
  notifyDrawn();
  return () => {
    const count = (drawnQuestions.get(requestId) ?? 1) - 1;
    if (count > 0) drawnQuestions.set(requestId, count);
    else drawnQuestions.delete(requestId);
    notifyDrawn();
  };
};

export const isQuestionDrawn = (requestId: string | undefined): boolean => (
  requestId !== undefined && drawnQuestions.has(requestId)
);

/** True while a plugin component in the chat draws this question. */
export const useQuestionDrawn = (requestId: string | undefined): boolean => React.useSyncExternalStore(
  subscribeDrawn,
  () => isQuestionDrawn(requestId),
  () => false,
);
