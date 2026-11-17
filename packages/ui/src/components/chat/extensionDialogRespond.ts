import { getPiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';

/** What a client sends for a blocking extension dialog. */
export type DialogAnswer = {
  cancelled?: boolean;
  confirmed?: boolean;
  value?: string;
  /** With a `choose` answer, when the dialog allows a note. */
  note?: string;
  values?: Record<string, string>;
};

/** The longest note a `choose` answer may carry; the server enforces the same cap. */
export const MAX_CHOICE_NOTE_CHARS = 2_000;

/** A `choose` answer: the choice id, and the note when it has text. */
export const choiceAnswer = (choiceId: string, note = ''): DialogAnswer => {
  const trimmed = note.trim().slice(0, MAX_CHOICE_NOTE_CHARS);
  return { value: choiceId, ...(trimmed ? { note: trimmed } : {}) };
};

/**
 * Answer a pending extension dialog and take it off the session's queue. A
 * dialog another device already answered counts as done; any other failure
 * throws and leaves the dialog in place.
 */
export const respondToExtensionDialog = async (
  sessionId: string,
  requestId: string,
  answer: DialogAnswer,
): Promise<void> => {
  try {
    await piClient.respondToExtensionDialog({ requestId, ...answer }, { runtimeKey: getRuntimeKey() });
    getPiSessionStore().dismissExtensionDialog(sessionId, requestId);
  } catch (error) {
    if (error instanceof PiRequestError && error.code === 'EXTENSION_DIALOG_NOT_PENDING') {
      getPiSessionStore().dismissExtensionDialog(sessionId, requestId);
      return;
    }
    throw error;
  }
};
