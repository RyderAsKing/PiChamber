import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/chat/types';

import {
  areOptionalNeighborMessagesEqual,
  areOptionalRenderRelevantMessagesEqual,
  areRenderRelevantMessagesEqual,
  areRenderRelevantPartsEqual,
  areRelevantTurnGroupingContextsEqual,
} from './renderCompare';
import type { TurnActivityRecord, TurnGroupingContext } from '../lib/turns/types';

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

/**
 * The ChatMessage/MessageRow memo boundaries compare message records and turn
 * grouping contexts through these helpers. After the response body stopped
 * owning tool/reasoning rendering (activities live only in the turn rail),
 * these tests pin both directions: render-relevant changes invalidate, and
 * semantically equivalent or unrelated updates preserve the boundary.
 */
describe('assistant render-relevance for the response-only body', () => {
  const activity = (overrides: Partial<TurnActivityRecord> & { id: string; messageId: string }): TurnActivityRecord => ({
    turnId: 'turn-1',
    partIndex: 0,
    kind: 'tool',
    part: { id: overrides.id, type: 'tool', tool: 'bash', state: { status: 'completed' } } as unknown as Part,
    ...overrides,
  } as TurnActivityRecord);

  const context = (activityParts: TurnActivityRecord[], overrides: Partial<TurnGroupingContext> = {}): TurnGroupingContext => ({
    turnId: 'turn-1',
    isFirstAssistantInTurn: true,
    isLastAssistantInTurn: true,
    isLatestTurn: true,
    isWorking: false,
    hasTools: true,
    hasReasoning: false,
    activityParts,
    ...overrides,
  } as TurnGroupingContext);

  test('same-id assistant message with identical rendered content stays memoized', () => {
    const left = record('a1', 'assistant', 'answer');
    const right = {
      info: { ...left.info },
      parts: [{ id: 'a1:text', type: 'text', text: 'answer' } as Part],
    };
    expect(areRenderRelevantMessagesEqual(left, right)).toBe(true);
  });

  test('same-id assistant message invalidates when final text content changes', () => {
    expect(areRenderRelevantMessagesEqual(
      record('a1', 'assistant', 'answer'),
      record('a1', 'assistant', 'answer, updated'),
    )).toBe(false);
  });

  test('same-id assistant message invalidates when its own activity part content changes', () => {
    const beforeParts = [activity({ id: 'tool-1', messageId: 'a1' })];
    const afterParts = [activity({ id: 'tool-1', messageId: 'a1' })];
    (afterParts[0] as { part: { state?: { status?: string } } }).part.state = { status: 'running' };
    const before = context(beforeParts);
    const after = context(afterParts);
    expect(areRelevantTurnGroupingContextsEqual(before, after, 'a1', false)).toBe(false);
  });

  test('activity changes confined to another message do not invalidate this response', () => {
    const before = context([activity({ id: 'tool-other', messageId: 'a0' })]);
    const after = context([
      { ...activity({ id: 'tool-other', messageId: 'a0' }), part: { id: 'tool-other', type: 'tool', tool: 'bash', state: { status: 'running' } } as unknown as Part },
    ]);
    expect(areRelevantTurnGroupingContextsEqual(before, after, 'a1', false)).toBe(true);
  });

  test('live working state and turn membership changes always invalidate', () => {
    const idle = context([]);
    const working = context([], { isWorking: true });
    expect(areRelevantTurnGroupingContextsEqual(idle, working, 'a1', false)).toBe(false);

    const notLast = context([], { isLastAssistantInTurn: false });
    expect(areRelevantTurnGroupingContextsEqual(idle, notLast, 'a1', false)).toBe(false);
  });
});
