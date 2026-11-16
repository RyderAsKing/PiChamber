import { describe, expect, test } from 'bun:test';

import { applyPiEvent, createReducerState, hydrateSessionFromDetail, type PiReducerState } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import { sessionHasSubagentCall } from './sessionCalls';

const SESSION = 'sess-1';

const event = <T extends PiSessionEvent['name']>(
  name: T,
  sequence: number,
  payload: Extract<PiSessionEvent, { name: T }>['payload'],
): Extract<PiSessionEvent, { name: T }> => ({
  protocolVersion: 1,
  kind: 'event',
  name,
  sequence,
  sessionId: SESSION,
  directory: '/work',
  payload,
} as Extract<PiSessionEvent, { name: T }>);

const started = (): PiReducerState => applyPiEvent(createReducerState(), event('assistant.message.start', 1, {
  messageId: 'm1', role: 'assistant', parentId: 'u1', startedAt: 1_000,
})).state;

const has = (state: PiReducerState) => sessionHasSubagentCall(state.bySession.get(SESSION));

describe('sessionHasSubagentCall', () => {
  test('is false without a session, and for a session with other tools only', () => {
    expect(sessionHasSubagentCall(undefined)).toBe(false);
    let state = started();
    expect(has(state)).toBe(false);
    state = applyPiEvent(state, event('session.tool.start', 2, {
      toolCallId: 't1', partId: 'p-bash', messageId: 'm1', name: 'bash', state: 'running', input: { command: 'ls' },
    })).state;
    expect(has(state)).toBe(false);
  });

  test('turns true with the first sub-agent call and stays true through its updates', () => {
    let state = started();
    state = applyPiEvent(state, event('session.tool.start', 2, {
      toolCallId: 't1', partId: 'p-bash', messageId: 'm1', name: 'bash', state: 'running', input: { command: 'ls' },
    })).state;
    // Asked before the call exists, so a remembered "no" must not outlive it.
    expect(has(state)).toBe(false);
    state = applyPiEvent(state, event('assistant.message.delta', 3, {
      messageId: 'm1', contentIndex: 1, delta: 'Handing this to a scout.',
    })).state;
    expect(has(state)).toBe(false);
    state = applyPiEvent(state, event('session.tool.start', 4, {
      toolCallId: 't2', partId: 'p-agent', messageId: 'm1', name: 'subagent', state: 'running',
      input: { agent: 'scout', task: 'Map the billing module' },
    })).state;
    expect(has(state)).toBe(true);
    state = applyPiEvent(state, event('session.tool.update', 5, {
      toolCallId: 't2', partId: 'p-agent', messageId: 'm1', name: 'subagent', state: 'running',
      metadata: { mode: 'single', results: [{ agent: 'scout', task: 'Map the billing module', status: 'running' }] },
    })).state;
    state = applyPiEvent(state, event('session.tool.end', 6, {
      toolCallId: 't2', partId: 'p-agent', messageId: 'm1', name: 'subagent', state: 'completed', endedAt: 2_000,
    })).state;
    expect(has(state)).toBe(true);
  });

  test('finds a call in a session loaded from history', () => {
    const { session } = hydrateSessionFromDetail({
      session: { id: SESSION, directory: '/work' },
      lastSequence: 9,
      messages: [{
        message: { id: 'm1', role: 'assistant', createdAt: 1_000, text: '', parentId: 'u1' },
        parts: [{
          id: 'p-agent', index: 0, type: 'tool', toolCallId: 't2', name: 'subagent', state: 'completed',
          input: { agent: 'scout', task: 'Map the billing module' },
        }],
      }],
    } as Parameters<typeof hydrateSessionFromDetail>[0]);
    expect(sessionHasSubagentCall(session)).toBe(true);
  });
});
