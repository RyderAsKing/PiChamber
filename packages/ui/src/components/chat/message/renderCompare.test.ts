import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/chat/types';

import { areOptionalNeighborMessagesEqual, areOptionalRenderRelevantMessagesEqual, areRenderRelevantPartsEqual } from './renderCompare';

const record = (id: string, role: 'user' | 'assistant', text: string) => ({
  info: { id, role, sessionID: 's1', time: { created: 1 } } as Message,
  parts: [{ id: `${id}:text`, type: 'text', text } as Part],
});

describe('areRenderRelevantPartsEqual', () => {
  test('invalidates a file part when its renderable metadata arrives', () => {
    const pending = [{ id: 'f1', type: 'file', filename: 'image.png', mime: 'image/png' } as Part];
    const hydrated = [{ ...pending[0], url: 'data:image/png;base64,AAA' } as Part];
    expect(areRenderRelevantPartsEqual(pending, hydrated)).toBe(false);
  });
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

  test('invalidates the rendered message when compaction feedback changes', () => {
    const running = record('a1', 'assistant', 'answer');
    const completed = record('a1', 'assistant', 'answer');
    (running.info as unknown as { error?: unknown }).error = { name: 'SessionCompaction', data: { phase: 'running' } };
    (completed.info as unknown as { error?: unknown }).error = { name: 'SessionCompaction', data: { phase: 'completed' } };

    expect(areOptionalRenderRelevantMessagesEqual(running, completed)).toBe(false);
    expect(areOptionalNeighborMessagesEqual(running, completed)).toBe(true);
  });

  test('treats a different neighbor id as a change', () => {
    expect(areOptionalNeighborMessagesEqual(
      record('a1', 'assistant', 'hel'),
      record('a2', 'assistant', 'hel'),
    )).toBe(false);
  });
});
