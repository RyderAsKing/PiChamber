/* eslint-disable */
// @ts-nocheck
import type { Session } from '@/lib/chat/types';

import { getSessionMetadata, type SessionMetadataRecord } from './sessionReviewMetadata';

export type ContextObligatoryMessage = {
  id: string;
  createdAt: number;
  role: 'user' | 'assistant';
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getContextObligatoryMessages = (
  session: Session | null | undefined,
): ContextObligatoryMessage[] => {
  const pichamber = getSessionMetadata(session).pichamber;
  if (!isRecord(pichamber) || !Array.isArray(pichamber.context_obligatory_messages)) return [];

  return pichamber.context_obligatory_messages.filter((value): value is ContextObligatoryMessage =>
    isRecord(value)
    && typeof value.id === 'string'
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && (value.role === 'user' || value.role === 'assistant'));
};

export const withContextObligatoryMessage = (
  metadata: SessionMetadataRecord,
  message: ContextObligatoryMessage,
  pinned: boolean,
): SessionMetadataRecord => {
  const pichamber = isRecord(metadata.pichamber) ? metadata.pichamber : {};
  const current = Array.isArray(pichamber.context_obligatory_messages)
    ? pichamber.context_obligatory_messages.filter((value): value is ContextObligatoryMessage =>
      isRecord(value) && typeof value.id === 'string')
    : [];
  const withoutMessage = current.filter((value) => value.id !== message.id);
  const nextMessages = pinned ? [...withoutMessage, message] : withoutMessage;

  return {
    ...metadata,
    pichamber: {
      ...pichamber,
      context_obligatory_messages: nextMessages,
    },
  };
};
