import { describe, expect, test } from 'bun:test';

import { applyPiEvent, createReducerState, type PiReducerState } from './event-reducer';
import type { PiSessionEvent } from './protocol';

const event = <T extends PiSessionEvent['name']>(
  name: T,
  sequence: number,
  payload: Extract<PiSessionEvent, { name: T }>['payload'],
): Extract<PiSessionEvent, { name: T }> => ({
  protocolVersion: 1,
  kind: 'event',
  name,
  sequence,
  sessionId: 'sess-1',
  directory: '/work',
  payload,
} as Extract<PiSessionEvent, { name: T }>);

const session = (state: PiReducerState) => state.bySession.get('sess-1');

describe('running extension command', () => {
  test('a busy frame naming a command sets it; a turn starting or idle clears it', () => {
    let state = applyPiEvent(createReducerState(), event('session.lifecycle', 1, { state: 'busy', command: '/pick' })).state;
    expect(session(state)?.lifecycle).toBe('busy');
    expect(session(state)?.runningCommand).toBe('/pick');

    // The command started an agent turn: steering applies again.
    state = applyPiEvent(state, event('assistant.message.start', 2, {
      messageId: 'a-1', role: 'assistant', text: '', startedAt: 1,
    } as Extract<PiSessionEvent, { name: 'assistant.message.start' }>['payload'])).state;
    expect(session(state)?.runningCommand).toBeUndefined();

    // The turn ended but the command still runs.
    state = applyPiEvent(state, event('session.lifecycle', 3, { state: 'busy', command: '/pick' })).state;
    expect(session(state)?.runningCommand).toBe('/pick');

    state = applyPiEvent(state, event('session.lifecycle', 4, { state: 'idle' })).state;
    expect(session(state)?.lifecycle).toBe('idle');
    expect(session(state)?.runningCommand).toBeUndefined();
  });

  test('a snapshot of a command-only run is busy without a streaming reply', () => {
    let state = applyPiEvent(createReducerState(), event('assistant.message.start', 1, {
      messageId: 'a-1', role: 'assistant', text: 'done', startedAt: 1,
    } as Extract<PiSessionEvent, { name: 'assistant.message.start' }>['payload'])).state;
    state = applyPiEvent(state, event('session.snapshot', 5, {
      snapshot: {
        sessionId: 'sess-1',
        directory: '/work',
        isStreaming: false,
        lifecycle: 'busy',
        command: '/overlay-sidepanel',
        queue: { steering: 0, followUp: 0 },
        lastSequence: 5,
      },
    })).state;
    expect(session(state)?.lifecycle).toBe('busy');
    expect(session(state)?.runningCommand).toBe('/overlay-sidepanel');
    expect(session(state)?.streamingMessages.size).toBe(0);
    expect(session(state)?.messages.get('a-1')?.streaming).toBeFalsy();

    state = applyPiEvent(state, event('session.snapshot', 6, {
      snapshot: {
        sessionId: 'sess-1',
        directory: '/work',
        isStreaming: false,
        lifecycle: 'idle',
        queue: { steering: 0, followUp: 0 },
        lastSequence: 6,
      },
    })).state;
    expect(session(state)?.runningCommand).toBeUndefined();
  });
});
