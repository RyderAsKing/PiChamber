import { describe, expect, test } from 'bun:test';

import {
  applyPiEvent,
  createReducerState,
  hydrateSessionFromDetail,
  type PiReducerSessionState,
} from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';

import { selectStreamingAssistantMessageId, shouldReuseSuspendedRecords, shouldReuseUserHistory } from './suspend-live-tail-records';

const baseEvent = <T extends PiSessionEvent['name']>(
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

const sessionOf = (state: ReturnType<typeof createReducerState>): PiReducerSessionState => {
  const session = state.bySession.get('sess-1');
  if (!session) throw new Error('missing session');
  return session;
};

const seedBusyAssistant = () => {
  let state = createReducerState();
  state = applyPiEvent(state, baseEvent('assistant.message.start', 1, {
    messageId: 'u1',
    role: 'user',
    startedAt: 1,
    text: 'hello',
  })).state;
  state = applyPiEvent(state, baseEvent('assistant.message.start', 2, {
    messageId: 'm1',
    role: 'assistant',
    parentId: 'u1',
    startedAt: 2,
  })).state;
  return state;
};

describe('shouldReuseSuspendedRecords', () => {
  test('reuses across text and thinking deltas on the suspended message', () => {
    let state = seedBusyAssistant();
    state = applyPiEvent(state, baseEvent('assistant.thinking.delta', 3, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'consider',
    })).state;
    const afterThink = sessionOf(state);

    state = applyPiEvent(state, baseEvent('assistant.thinking.delta', 4, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'consider more',
    })).state;
    const afterThinkMore = sessionOf(state);
    expect(shouldReuseSuspendedRecords(afterThink, afterThinkMore, 'm1')).toBe(true);

    state = applyPiEvent(state, baseEvent('assistant.message.delta', 5, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'answer',
    })).state;
    expect(shouldReuseSuspendedRecords(afterThinkMore, sessionOf(state), 'm1')).toBe(true);
  });

  test('reuses when a tool starts on the suspended message', () => {
    let state = seedBusyAssistant();
    state = applyPiEvent(state, baseEvent('assistant.message.delta', 3, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'working',
    })).state;
    const beforeTool = sessionOf(state);

    state = applyPiEvent(state, baseEvent('session.tool.start', 4, {
      messageId: 'm1',
      partId: 'm1:tool:0',
      toolCallId: 'c1',
      name: 'bash',
      state: 'running',
      input: { command: 'ls' },
    })).state;
    expect(shouldReuseSuspendedRecords(beforeTool, sessionOf(state), 'm1')).toBe(true);
  });

  test('does not reuse when a new message arrives', () => {
    let state = seedBusyAssistant();
    state = applyPiEvent(state, baseEvent('assistant.message.delta', 3, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'working',
    })).state;
    const beforeUser = sessionOf(state);

    state = applyPiEvent(state, baseEvent('assistant.message.start', 4, {
      messageId: 'u2',
      role: 'user',
      startedAt: 4,
      text: 'steer',
    })).state;
    expect(shouldReuseSuspendedRecords(beforeUser, sessionOf(state), 'm1')).toBe(false);
  });

  test('reuses from lastMutationKind without scanning historical parts', () => {
    let state = seedBusyAssistant();
    state = applyPiEvent(state, baseEvent('assistant.message.delta', 3, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'working',
    })).state;
    const before = sessionOf(state);
    state = applyPiEvent(state, baseEvent('assistant.message.delta', 4, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'working more',
    })).state;
    const after = sessionOf(state);
    expect(after.lastMutationKind).toBe('part');
    expect(after.lastMutatedMessageId).toBe('m1');
    expect(shouldReuseSuspendedRecords(before, after, 'm1')).toBe(true);
  });

  test('selects the live assistant id and keeps it across token deltas', () => {
    let state = seedBusyAssistant();
    expect(selectStreamingAssistantMessageId(sessionOf(state))).toBe('m1');

    const beforeDelta = sessionOf(state);
    state = applyPiEvent(state, baseEvent('assistant.message.delta', 3, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'working',
    })).state;
    const afterDelta = sessionOf(state);
    expect(selectStreamingAssistantMessageId(afterDelta)).toBe('m1');
    expect(shouldReuseSuspendedRecords(
      beforeDelta,
      afterDelta,
      selectStreamingAssistantMessageId(afterDelta) ?? '',
    )).toBe(true);

    state = applyPiEvent(state, baseEvent('assistant.message.end', 4, {
      messageId: 'm1',
      text: 'working',
    })).state;
    expect(selectStreamingAssistantMessageId(sessionOf(state))).toBeNull();
  });

  test('keeps the canonical hydrated assistant id when resumed events use a live alias', () => {
    const directory = '/work';
    const hydrated = hydrateSessionFromDetail({
      session: { id: 'sess-1', directory },
      lastSequence: 9,
      isStreaming: true,
      lifecycle: 'busy',
      messages: [{
        message: {
          id: 'persisted-assistant',
          sessionId: 'sess-1',
          directory,
          role: 'assistant',
          text: 'before',
          thinking: '',
          createdAt: 1,
          model: { providerId: 'test', modelId: 'model' },
        },
        parts: [{ id: 'persisted-assistant:text:0', index: 0, type: 'text', text: 'before' }],
      }],
    }).state;
    const before = sessionOf(hydrated);

    const afterThinkingState = applyPiEvent(hydrated, baseEvent('assistant.thinking.delta', 10, {
      messageId: 'assistant-sess-1-8',
      partId: 'assistant-sess-1-8:thinking:0',
      contentIndex: 0,
      delta: 'considering',
    })).state;
    const afterThinking = sessionOf(afterThinkingState);
    expect(afterThinking.messages.get('assistant-sess-1-8')?.id).toBe('persisted-assistant');
    expect(selectStreamingAssistantMessageId(afterThinking)).toBe('persisted-assistant');
    expect(afterThinking.lastMutatedMessageId).toBe('persisted-assistant');
    expect(shouldReuseSuspendedRecords(before, afterThinking, 'persisted-assistant')).toBe(true);

    const afterTextState = applyPiEvent(afterThinkingState, baseEvent('assistant.message.delta', 11, {
      messageId: 'assistant-sess-1-8',
      partId: 'assistant-sess-1-8:text:0',
      contentIndex: 0,
      delta: ' after',
    })).state;
    const afterText = sessionOf(afterTextState);
    expect(selectStreamingAssistantMessageId(afterText)).toBe('persisted-assistant');
    expect(afterText.lastMutatedMessageId).toBe('persisted-assistant');
    expect(shouldReuseSuspendedRecords(afterThinking, afterText, 'persisted-assistant')).toBe(true);

    const afterToolState = applyPiEvent(afterTextState, baseEvent('session.tool.start', 12, {
      messageId: 'assistant-sess-1-8',
      partId: 'assistant-sess-1-8:tool:call-1',
      toolCallId: 'call-1',
      name: 'read',
      state: 'running',
    })).state;
    const afterTool = sessionOf(afterToolState);
    expect(selectStreamingAssistantMessageId(afterTool)).toBe('persisted-assistant');
    expect(afterTool.lastMutatedMessageId).toBe('persisted-assistant');
    expect(shouldReuseSuspendedRecords(afterText, afterTool, 'persisted-assistant')).toBe(true);
  });

  test('reuses user history across assistant token deltas', () => {
    let state = seedBusyAssistant();
    const before = sessionOf(state);
    state = applyPiEvent(state, baseEvent('assistant.message.delta', 3, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'working',
    })).state;
    const after = sessionOf(state);
    expect(shouldReuseUserHistory(before, after)).toBe(true);

    state = applyPiEvent(state, baseEvent('assistant.message.start', 4, {
      messageId: 'u2',
      role: 'user',
      startedAt: 4,
      text: 'again',
    })).state;
    expect(shouldReuseUserHistory(after, sessionOf(state))).toBe(false);
  });
});
