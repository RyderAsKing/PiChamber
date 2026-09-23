import { describe, expect, test } from 'bun:test';

import { uniqueSessionMessages } from './reducerHelpers';
import { hydrateSessionFromDetail, projectSession } from './sessionProjection';
import type { PiReducerMessage, PiReducerSessionState } from './reducerTypes';

const message = (id: string, createdAt: number, extras: Partial<PiReducerMessage> = {}): PiReducerMessage => ({
  id,
  sessionId: 's',
  directory: '/repo',
  role: 'assistant',
  createdAt,
  text: '',
  thinking: '',
  streaming: false,
  ...extras,
} as PiReducerMessage);

describe('uniqueSessionMessages', () => {
  test('a same-key replacement is not hidden by the ordered-list cache', () => {
    const messages = new Map<string, PiReducerMessage>([['u1', message('u1', 1, { role: 'user' })], ['a1', message('a1', 2)]]);
    const session = { messages } as unknown as PiReducerSessionState;
    expect(uniqueSessionMessages(session)[1]?.streaming).toBe(false);

    messages.set('a1', { ...messages.get('a1')!, streaming: true });

    expect(uniqueSessionMessages(session)[1]?.streaming).toBe(true);
  });

  test('an unchanged map returns the cached list', () => {
    const messages = new Map<string, PiReducerMessage>([['a1', message('a1', 2)]]);
    const session = { messages } as unknown as PiReducerSessionState;
    expect(uniqueSessionMessages(session)).toBe(uniqueSessionMessages(session));
  });
});

describe('hydrating a session whose turn is still running', () => {
  test('the projected in-flight assistant is streaming', () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: 's', directory: '/repo' },
      messages: [
        { message: { id: 'u1', sessionId: 's', directory: '/repo', role: 'user', createdAt: 1, text: 'hi' }, parts: [] },
        { message: { id: 'a1', sessionId: 's', directory: '/repo', role: 'assistant', parentId: 'u1', createdAt: 2, text: 'partial' }, parts: [] },
      ],
      lastSequence: 10,
      isStreaming: true,
      lifecycle: 'busy',
    } as Parameters<typeof hydrateSessionFromDetail>[0]);

    expect(session.messages.get('a1')?.streaming).toBe(true);
    const projected = projectSession(session).messages.find((entry) => entry.id === 'a1');
    expect(projected?.streaming).toBe(true);
  });
});
