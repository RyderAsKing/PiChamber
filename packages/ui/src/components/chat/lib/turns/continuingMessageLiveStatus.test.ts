import { describe, expect, test } from 'bun:test';

import {
  applyPiEvent,
  createReducerState,
  projectSession,
  type PiProjectedSession,
  type PiReducerSessionState,
} from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import { piProjectedToRecords } from '@/lib/chat/pi-to-renderable';
import type { SessionMessageRecord } from '@/lib/chat/types';
import { projectTurnRecords } from './projectTurnRecords';
import {
  isSessionAssistantWorking,
  shouldShowTurnWorkingStatus,
} from './assistantWorkingState';
import {
  selectStreamingAssistantMessageId,
  shouldReuseSuspendedRecords,
} from '@/sync/suspend-live-tail-records';
import { turnContainsMessageId } from '../messageListHelpers';

const baseEvent = <T extends PiSessionEvent['name']>(
  name: T,
  sequence: number,
  payload: Extract<PiSessionEvent, { name: T }>['payload'],
  sessionId = 'sess-1',
  directory = '/work',
): Extract<PiSessionEvent, { name: T }> =>
  ({
    protocolVersion: 1,
    kind: 'event',
    name,
    sequence,
    sessionId,
    directory,
    payload,
  }) as Extract<PiSessionEvent, { name: T }>;

const showWorkingFromRecords = (
  records: SessionMessageRecord[],
  lifecycle: string,
  activeStreamingMessageId: string | null,
) => {
  const projection = projectTurnRecords(records);
  const turn = projection.turns[0];
  const lastRecord = records[records.length - 1];
  const lastInfo = lastRecord?.info as
    | { role?: string; finish?: string; time?: { completed?: number } }
    | undefined;
  const hasPendingAssistant = Boolean(
    lastRecord &&
      lastInfo?.role === 'assistant' &&
      typeof lastInfo?.time?.completed !== 'number' &&
      lastInfo?.finish !== 'stop' &&
      lastInfo?.finish !== 'error',
  );
  const sessionIsWorking = isSessionAssistantWorking({
    connection: 'ready',
    authoritativeWorking: lifecycle === 'busy' || lifecycle === 'retry',
    hasPendingAssistant,
  });
  const turnOwnsAuthoritativeStream = turn
    ? turnContainsMessageId(turn, activeStreamingMessageId)
    : false;
  const turnIsInActiveStream = Boolean(
    turn?.stream.isStreaming && turnOwnsAuthoritativeStream,
  );
  const showWorkingStatus = turn
    ? shouldShowTurnWorkingStatus({
        isLastTurn: true,
        sessionIsWorking,
        turnIsInActiveStream,
        activeStreamingMessageId,
      })
    : false;
  return {
    projection,
    turn,
    hasPendingAssistant,
    sessionIsWorking,
    turnOwnsAuthoritativeStream,
    turnIsInActiveStream,
    showWorkingStatus,
  };
};

const deriveLiveView = (session: PiReducerSessionState) => {
  const projected = projectSession(session);
  const records = piProjectedToRecords(projected);
  const activeStreamingMessageId = selectStreamingAssistantMessageId(session);
  const lifecycle = session.lifecycle;
  const view = showWorkingFromRecords(records, lifecycle, activeStreamingMessageId);
  return {
    lifecycle,
    activeStreamingMessageId,
    records,
    projected,
    ...view,
  };
};

/**
 * Minimal hook simulator for `useSessionMessageRecords` freeze + remount.
 * `renderHook` mimics the frozen tail (reuses previous records while
 * `shouldReuseSuspendedRecords` holds). `renderFresh` mimics navigation /
 * remount clearing `previousRef` (projects without previous).
 */
const createTailSimulator = () => {
  let publishedSession: PiReducerSessionState | null = null;
  let publishedProjection: PiProjectedSession | null = null;
  let publishedRecords: SessionMessageRecord[] | null = null;
  return {
    renderHook(session: PiReducerSessionState) {
      if (!publishedSession || !publishedProjection || !publishedRecords) {
        const projection = projectSession(session);
        const records = piProjectedToRecords(projection);
        publishedSession = session;
        publishedProjection = projection;
        publishedRecords = records;
        return { records, projection, reused: false };
      }
      const suspendId =
        selectStreamingAssistantMessageId(session) ??
        selectStreamingAssistantMessageId(publishedSession);
      if (
        suspendId &&
        shouldReuseSuspendedRecords(publishedSession, session, suspendId)
      ) {
        return {
          records: publishedRecords,
          projection: publishedProjection,
          reused: true,
        };
      }
      const projection = projectSession(session, {
        session: publishedSession,
        projection: publishedProjection,
      });
      const records = piProjectedToRecords(projection);
      publishedSession = session;
      publishedProjection = projection;
      publishedRecords = records;
      return { records, projection, reused: false };
    },
    renderFresh(session: PiReducerSessionState) {
      const projection = projectSession(session);
      const records = piProjectedToRecords(projection);
      return { records, projection };
    },
    reset() {
      publishedSession = null;
      publishedProjection = null;
      publishedRecords = null;
    },
  };
};

const seedLiveAssistant = () => {
  let state = createReducerState();
  state = applyPiEvent(
    state,
    baseEvent('assistant.message.start', 1, {
      messageId: 'u1',
      role: 'user',
      text: 'do thing',
      startedAt: 1_000,
    }),
  ).state;
  state = applyPiEvent(
    state,
    baseEvent('assistant.message.start', 2, {
      messageId: 'm1',
      role: 'assistant',
      parentId: 'u1',
      startedAt: 1_100,
    }),
  ).state;
  state = applyPiEvent(
    state,
    baseEvent('assistant.message.delta', 3, {
      messageId: 'm1',
      contentIndex: 0,
      delta: 'first token',
    }),
  ).state;
  return state;
};

describe('continuing assistant.message.end keeps the turn live', () => {
  test('frozen tail agrees with fresh remount through tool execution', () => {
    let state = seedLiveAssistant();
    const tail = createTailSimulator();
    const liveSession = state.bySession.get('sess-1') as PiReducerSessionState;
    tail.renderHook(liveSession);
    state = applyPiEvent(
      state,
      baseEvent('assistant.message.end', 4, {
        messageId: 'm1',
        text: 'first token',
        continuing: true,
      }),
    ).state;
    const continuingSession = state.bySession.get('sess-1') as PiReducerSessionState;
    // Prime the frozen tail with the continuing snapshot (completed pre-fix,
    // live post-fix). The hook busts on structure here, so it publishes
    // whatever the reducer projected at the boundary.
    tail.renderHook(continuingSession);
    state = applyPiEvent(
      state,
      baseEvent('session.tool.start', 5, {
        toolCallId: 't1',
        partId: 'm1:tool:t1',
        messageId: 'm1',
        name: 'bash',
        state: 'running',
        input: { cmd: 'pwd' },
        startedAt: 1_200,
      }),
    ).state;
    const toolSession = state.bySession.get('sess-1') as PiReducerSessionState;
    const hookResult = tail.renderHook(toolSession);
    const freshResult = tail.renderFresh(toolSession);
    const frozenView = showWorkingFromRecords(
      hookResult.records,
      toolSession.lifecycle,
      selectStreamingAssistantMessageId(toolSession),
    );
    const freshView = showWorkingFromRecords(
      freshResult.records,
      toolSession.lifecycle,
      selectStreamingAssistantMessageId(toolSession),
    );
    // Fresh/remount isolates the cause: navigation clears previousRef and
    // projects the live reducer state. Pre-fix fresh is live (true) while
    // the frozen tail holds the completed snapshot (false), proving the
    // holder is the freeze, not a transient completion or epoch-stale
    // publication (sequence is in-order, lifecycle stays busy).
    expect(freshView.showWorkingStatus).toBe(true);
    expect(hookResult.reused).toBe(true);
    expect(frozenView.showWorkingStatus).toBe(true);
  });

  test('stays live across end{continuing:true} until tool.start and terminal idle', () => {
    let state = seedLiveAssistant();
    const tail = createTailSimulator();

    const liveSession = state.bySession.get('sess-1') as PiReducerSessionState;
    const live = deriveLiveView(liveSession);
    expect(live.lifecycle).toBe('busy');
    expect(live.activeStreamingMessageId).toBe('m1');
    expect(live.sessionIsWorking).toBe(true);
    // Behavioral assertion: the user-visible working footer must be shown.
    // Do not overconstrain the internal stream-flag representation here.
    expect(live.showWorkingStatus).toBe(true);
    tail.renderHook(liveSession);

    // First assistant segment ends but Pi will continue with tool calls.
    // Lifecycle stays busy and the reducer retains live ownership.
    state = applyPiEvent(
      state,
      baseEvent('assistant.message.end', 4, {
        messageId: 'm1',
        text: 'first token',
        continuing: true,
      }),
    ).state;
    const continuingSession = state.bySession.get(
      'sess-1',
    ) as PiReducerSessionState;
    expect(continuingSession.lifecycle).toBe('busy');
    expect(continuingSession.streamingMessages.has('m1')).toBe(true);

    // Fresh projection (remount / navigation clears previousRef) must stay
    // live across the continuing boundary. Pre-fix this is false because
    // pi-to-renderable stamps time.completed from !streaming while TurnBlock
    // still requires stream.isStreaming plus ownership, and the shouldShow
    // fallback is blocked by the retained id.
    const continuing = deriveLiveView(continuingSession);
    expect(continuing.activeStreamingMessageId).toBe('m1');
    expect(continuing.sessionIsWorking).toBe(true);
    expect(continuing.showWorkingStatus).toBe(true);
    tail.renderHook(continuingSession);

    // Tool execution resumes on the same assistant message. The hook tail
    // freezes part deltas on the suspended message; a fresh remount must
    // agree with the frozen view. Pre-fix the frozen tail holds the
    // completed snapshot (showWorking false) while a fresh projection is
    // live (showWorking true), isolating the freeze as the holder of stale
    // state rather than a transient completion or epoch-stale publication.
    state = applyPiEvent(
      state,
      baseEvent('session.tool.start', 5, {
        toolCallId: 't1',
        partId: 'm1:tool:t1',
        messageId: 'm1',
        name: 'bash',
        state: 'running',
        input: { cmd: 'pwd' },
        startedAt: 1_200,
      }),
    ).state;
    const toolSession = state.bySession.get('sess-1') as PiReducerSessionState;
    expect(toolSession.lifecycle).toBe('busy');
    expect(selectStreamingAssistantMessageId(toolSession)).toBe('m1');

    const hookResult = tail.renderHook(toolSession);
    const freshResult = tail.renderFresh(toolSession);
    const frozenView = showWorkingFromRecords(
      hookResult.records,
      toolSession.lifecycle,
      selectStreamingAssistantMessageId(toolSession),
    );
    const freshView = showWorkingFromRecords(
      freshResult.records,
      toolSession.lifecycle,
      selectStreamingAssistantMessageId(toolSession),
    );
    // Fresh/remount (navigation clears previousRef) projects the live state.
    expect(freshView.showWorkingStatus).toBe(true);
    // Frozen tail must agree: tool.start on the suspended message reuses the
    // tail overlay, but the displayed working footer must stay live.
    expect(hookResult.reused).toBe(true);
    expect(frozenView.showWorkingStatus).toBe(true);

    // True terminal: tool completes and the lifecycle settles.
    state = applyPiEvent(
      state,
      baseEvent('session.tool.end', 6, {
        toolCallId: 't1',
        partId: 'm1:tool:t1',
        messageId: 'm1',
        name: 'bash',
        state: 'completed',
        output: '/workspace',
        endedAt: 1_300,
      }),
    ).state;
    state = applyPiEvent(
      state,
      baseEvent('assistant.message.end', 7, {
        messageId: 'm1',
        text: 'first token',
      }),
    ).state;
    state = applyPiEvent(
      state,
      baseEvent('session.lifecycle', 8, { state: 'idle' }),
    ).state;
    const settledSession = state.bySession.get(
      'sess-1',
    ) as PiReducerSessionState;
    const settled = deriveLiveView(settledSession);
    expect(settled.lifecycle).toBe('idle');
    expect(settled.activeStreamingMessageId).toBeNull();
    expect(settled.sessionIsWorking).toBe(false);
    expect(settled.showWorkingStatus).toBe(false);
  });

  test('continuing keeps reducer streaming ownership until terminal end', () => {
    let state = seedLiveAssistant();
    state = applyPiEvent(
      state,
      baseEvent('assistant.message.end', 4, {
        messageId: 'm1',
        text: 'first token',
        continuing: true,
      }),
    ).state;
    const continuingSession = state.bySession.get('sess-1') as PiReducerSessionState;
    // Owning-core contract: continuing ends a segment, not the turn.
    expect(continuingSession.messages.get('m1')?.streaming).toBe(true);
    expect(continuingSession.streamingMessages.has('m1')).toBe(true);
    state = applyPiEvent(
      state,
      baseEvent('session.tool.start', 5, {
        toolCallId: 't1',
        partId: 'm1:tool:t1',
        messageId: 'm1',
        name: 'bash',
        state: 'running',
        input: { cmd: 'pwd' },
        startedAt: 1_200,
      }),
    ).state;
    const toolSession = state.bySession.get('sess-1') as PiReducerSessionState;
    expect(toolSession.messages.get('m1')?.streaming).toBe(true);
    expect(toolSession.streamingMessages.has('m1')).toBe(true);
    state = applyPiEvent(
      state,
      baseEvent('session.tool.end', 6, {
        toolCallId: 't1',
        partId: 'm1:tool:t1',
        messageId: 'm1',
        name: 'bash',
        state: 'completed',
        output: '/workspace',
        endedAt: 1_300,
      }),
    ).state;
    state = applyPiEvent(
      state,
      baseEvent('assistant.message.end', 7, {
        messageId: 'm1',
        text: 'first token',
      }),
    ).state;
    const terminalSession = state.bySession.get('sess-1') as PiReducerSessionState;
    expect(terminalSession.messages.get('m1')?.streaming).toBe(false);
    expect(terminalSession.streamingMessages.has('m1')).toBe(false);
  });
});
