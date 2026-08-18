import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/chat/types';

import { areOptionalNeighborMessagesEqual, areOptionalRenderRelevantMessagesEqual } from './renderCompare';

const record = (id: string, role: 'user' | 'assistant', text: string) => ({
  info: { id, role, sessionID: 's1', time: { created: 1 } } as Message,
  parts: [{ id: `${id}:text`, type: 'text', text } as Part],
});

describe('areOptionalNeighborMessagesEqual', () => {
  test('ignores streaming text growth on the neighbor', () => {
    const user = record('u1', 'user', 'prompt');
    const assistantShort = record('a1', 'assistant', 'hel');
    const assistantLong = record('a1', 'assistant', 'hello world');

    expect(areOptionalRenderRelevantMessagesEqual(assistantShort, assistantLong)).toBe(false);
    expect(areOptionalNeighborMessagesEqual(assistantShort, assistantLong)).toBe(true);
    expect(areOptionalNeighborMessagesEqual(user, user)).toBe(true);
  });

  test('treats a different neighbor id as a change', () => {
    expect(areOptionalNeighborMessagesEqual(
      record('a1', 'assistant', 'hel'),
      record('a2', 'assistant', 'hel'),
    )).toBe(false);
  });
});
