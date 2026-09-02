/**
 * Pi event reducer helpers — apply sequenced events from the public stream
 * to running per-session state.
 *
 * The reducer is the small, pure function at the center of the PiChamber UI
 * migration. It is responsible for:
 *
 * - Sequencing: events with a `sequence` <= the last accepted sequence are
 *   ignored. This is what makes reconnect safe: a client can resume from
 *   `snapshot.lastSequence` and the reducer will discard anything it has
 *   already applied.
 * - Stream assembly: text and thinking deltas are merged per part with
 *   `applyAssistantTextDelta`. A thinking part stops streaming as soon as
 *   a later text or tool part on the same message starts, so the thinking
 *   UI can collapse at handoff rather than waiting for `assistant.message.end`.
 *   `assistant.message.end` writes canonical text/thinking onto those parts
 *   so the chat does not keep a corrupted live assembly after the daemon
 *   publishes the finished message.
 * - Lifecycle: the `session.lifecycle` event flips the running state.
 *   `session.interrupted` flips the streaming flag back off without
 *   marking the message completed; that is the visible "interrupted" UI
 *   state the plan requires.
 *
 * The reducer is intentionally a plain function so it can be reused by
 * bootstrap, reconnect, and live-stream code paths without coupling to any
 * store implementation. The store wrapper lives in `packages/ui/src/sync/`.
 */

import type {
  PiExtensionAppPayload,
  PiExtensionDialogPayload,
  PiExtensionPanelPayload,
  PiSessionEvent,
} from './protocol';
import type {
  ApplyEventResult,
  PiProjectedMessage,
  PiProjectedMessagePart,
  PiProjectedSession,
  PiReducerMessage,
  PiReducerMessagePart,
  PiReducerMutationKind,
  PiReducerPartMap,
  PiReducerSessionState,
  PiReducerState,
  ProjectSessionPrevious,
} from './reducers/reducerTypes';
import {
  createReducerPartMap,
  createReducerState,
} from './reducers/reducerTypes';
import {
  aliasSyntheticUserIfPersisted,
  emptySessionParts,
  forkPartsForWrite,
  markMutation,
} from './reducers/reducerHelpers';
import {
  reduceAssistantDelta,
  reduceError,
  reduceInterrupted,
  reduceLifecycle,
  reduceMessageEnd,
  reduceMessageStart,
  reduceTool,
} from './reducers/streamReducers';
import {
  dismissExtensionDialog,
  reduceExtensionApp,
  reduceExtensionCatalog,
  reduceExtensionDialog,
  reduceExtensionDialogDismiss,
  reduceExtensionEditor,
  reduceExtensionEntry,
  reduceExtensionError,
  reduceExtensionMessage,
  reduceExtensionNotify,
  reduceExtensionStatus,
  reduceExtensionTitle,
  reduceExtensionUi,
  reduceExtensionWidget,
} from './reducers/extensionReducers';
import {
  hydrateSessionFromDetail,
  markHydratedLiveActivity,
  projectSession,
} from './reducers/sessionProjection';

export type {
  ApplyEventResult,
  PiProjectedMessage,
  PiProjectedMessagePart,
  PiProjectedSession,
  PiReducerMessage,
  PiReducerMessagePart,
  PiReducerMutationKind,
  PiReducerPartMap,
  PiReducerSessionState,
  PiReducerState,
  ProjectSessionPrevious,
};

export {
  aliasSyntheticUserIfPersisted,
  createReducerPartMap,
  createReducerState,
  dismissExtensionDialog,
  hydrateSessionFromDetail,
  projectSession,
};

/**
 * Apply a single event. Returns a new state plus a `didApply` flag.
 * `didApply` is `false` when the event was rejected for sequencing, so
 * callers must not mutate downstream views in that case.
 */
export const applyPiEvent = (
  state: PiReducerState,
  event: PiSessionEvent,
): ApplyEventResult => {
  const last = state.lastSequence.get(event.sessionId) ?? -1;
  if (event.sequence <= last) {
    return { state, didApply: false };
  }

  const current = state.bySession.get(event.sessionId);
  const session: PiReducerSessionState = current
    ? {
        ...current,
        lastSequence: event.sequence,
        ...(event.name === 'session.lifecycle' ? { lifecycle: event.payload.state } : {}),
        ...(event.name === 'session.queue' ? { queue: { ...event.payload } } : {}),
        ...(event.name === 'session.model' ? { model: event.payload.model } : {}),
        ...(event.name === 'session.thinking' ? { thinking: event.payload.thinking } : {}),
      }
    : {
        sessionId: event.sessionId,
        directory: event.directory,
        lastSequence: event.sequence,
        lifecycle: 'idle',
        messages: new Map(),
        partOrder: new Map(),
        parts: emptySessionParts(),
        toolsByCallId: new Map(),
        streamingMessages: new Set(),
        queue: { steering: 0, followUp: 0 },
        extensionStatuses: new Map(),
        extensionWidgets: new Map(),
        extensionDialogs: [],
        extensionNotices: [],
        extensionErrors: [],
        extensionPanels: new Map(),
        extensionApps: new Map(),
      };
  switch (event.name) {
    case 'session.snapshot':
      if (event.payload?.snapshot) {
        session.lifecycle = event.payload.snapshot.lifecycle ?? (event.payload.snapshot.isStreaming ? 'busy' : 'idle');
        session.retry = session.lifecycle === 'retry' ? event.payload.snapshot.retry : undefined;
        session.compaction = event.payload.snapshot.compaction;
        if (event.payload.snapshot.model) session.model = event.payload.snapshot.model;
        if (event.payload.snapshot.thinking) session.thinking = event.payload.snapshot.thinking;
        if (event.payload.snapshot.queue) session.queue = { ...event.payload.snapshot.queue };
        // Snapshot may carry current extension live state for reconnect after
        // the replay window. Replace the session's extension maps so a phone
        // that reconnected late still sees approval prompts and sub-agent panels.
        if (Array.isArray(event.payload.snapshot.extensionStatuses)) {
          session.extensionStatuses = new Map(event.payload.snapshot.extensionStatuses.map((entry) => [entry.key, entry.text]));
        }
        if (Array.isArray(event.payload.snapshot.extensionWidgets)) {
          session.extensionWidgets = new Map(event.payload.snapshot.extensionWidgets.map((entry) => [entry.key, { lines: entry.lines, placement: entry.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor' }]));
        }
        if (Array.isArray(event.payload.snapshot.extensionDialogs)) {
          // The snapshot is authoritative for pending dialogs. Keeping a local
          // request that the daemon omitted would resurrect an answered,
          // timed-out, or aborted blocking modal after reconnect.
          session.extensionDialogs = event.payload.snapshot.extensionDialogs.filter(
            (dialog) => typeof dialog.requestId === 'string' && typeof dialog.method === 'string' && typeof dialog.title === 'string',
          ) as PiExtensionDialogPayload[];
        }
        if (Array.isArray(event.payload.snapshot.extensionPanels)) {
          const panels = new Map<string, PiExtensionPanelPayload>();
          for (const panel of event.payload.snapshot.extensionPanels) {
            if (typeof panel?.id === 'string' && panel.id.length > 0) panels.set(panel.id, panel);
          }
          session.extensionPanels = panels;
        }
        if (Array.isArray(event.payload.snapshot.extensionApps)) {
          const apps = new Map<string, PiExtensionAppPayload>();
          for (const app of event.payload.snapshot.extensionApps) {
            if (typeof app?.appId === 'string' && app.appId.length > 0) apps.set(app.appId, app);
          }
          session.extensionApps = apps;
        }
        session.extensionTitle = event.payload.snapshot.extensionTitle;
        markHydratedLiveActivity(session, {
          isStreaming: event.payload.snapshot.isStreaming,
          lifecycle: session.lifecycle,
          ...(event.payload.snapshot.retry ? { retry: event.payload.snapshot.retry } : {}),
          settleWhenIdle: true,
        });
      }
      break;
    case 'session.lifecycle':
      reduceLifecycle(session, event.payload);
      break;
    case 'assistant.message.start':
      // A message start is live turn evidence even when the lifecycle frame
      // was missed or has not arrived yet. During an automatic retry it only
      // means the request started; keep the retry notice until actual output
      // arrives.
      session.lifecycle = session.retry ? 'retry' : 'busy';
      session.messages = new Map(session.messages);
      session.streamingMessages = new Set(session.streamingMessages);
      reduceMessageStart(session, event.directory, event.payload);
      if (event.payload.role === 'assistant') session.streamingMessages.add(event.payload.messageId);
      markMutation(session, event.payload.messageId, 'structure');
      break;
    case 'assistant.message.delta':
      forkPartsForWrite(session);
      if (reduceAssistantDelta(session, event.payload, 'text')) {
        session.lifecycle = 'busy';
        session.retry = undefined;
      }
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'assistant.message.end':
      session.messages = new Map(session.messages);
      forkPartsForWrite(session);
      session.partOrder = new Map(session.partOrder);
      session.streamingMessages = new Set(session.streamingMessages);
      reduceMessageEnd(session, event.payload);
      markMutation(session, event.payload.messageId, 'structure');
      break;
    case 'assistant.thinking.delta':
      forkPartsForWrite(session);
      if (reduceAssistantDelta(session, event.payload, 'thinking')) {
        session.lifecycle = 'busy';
        session.retry = undefined;
      }
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'session.tool.start':
      forkPartsForWrite(session);
      session.partOrder = new Map(session.partOrder);
      session.toolsByCallId = new Map(session.toolsByCallId);
      if (reduceTool(session, 'start', event.payload)) {
        session.lifecycle = 'busy';
        session.retry = undefined;
      }
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'session.tool.update':
      forkPartsForWrite(session);
      if (reduceTool(session, 'update', event.payload)) {
        session.lifecycle = 'busy';
        session.retry = undefined;
      }
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'session.tool.end':
      forkPartsForWrite(session);
      if (reduceTool(session, 'end', event.payload)) {
        session.lifecycle = 'busy';
        session.retry = undefined;
      }
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'session.queue':
      session.queue = {
        steering: event.payload.steering,
        followUp: event.payload.followUp,
      };
      break;
    case 'session.model':
      session.model = event.payload.model;
      break;
    case 'session.thinking':
      session.thinking = event.payload.thinking;
      break;
    case 'session.compaction':
      session.compaction = { ...event.payload };
      break;
    case 'session.updated':
      // Title/metadata lives in the live catalog, not the transcript reducer.
      break;
    case 'session.tree.updated':
      session.sessionTreeRevision = (session.sessionTreeRevision ?? 0) + 1;
      break;
    case 'session.error':
      session.messages = new Map(session.messages);
      session.streamingMessages = new Set(session.streamingMessages);
      for (const messageId of session.streamingMessages) {
        const message = session.messages.get(messageId);
        if (message) session.messages.set(messageId, { ...message });
      }
      reduceError(session, event.payload.code, event.payload.message);
      break;
    case 'session.interrupted':
      session.messages = new Map(session.messages);
      session.streamingMessages = new Set(session.streamingMessages);
      for (const messageId of session.streamingMessages) {
        const message = session.messages.get(messageId);
        if (message) session.messages.set(messageId, { ...message });
      }
      reduceInterrupted(session, event.payload.streaming);
      break;
    case 'extension.entry':
      reduceExtensionEntry(session, event.directory, event.sessionId, event.payload);
      break;
    case 'extension.message':
      reduceExtensionMessage(session, event.directory, event.sessionId, event.payload);
      break;
    case 'extension.notify':
      reduceExtensionNotify(session, event.payload);
      break;
    case 'extension.catalog':
      reduceExtensionCatalog(session, event.payload);
      break;
    case 'extension.editor':
      reduceExtensionEditor(session, event.payload, event.sequence);
      break;
    case 'extension.title':
      reduceExtensionTitle(session, event.payload);
      break;
    case 'extension.status':
      reduceExtensionStatus(session, event.payload);
      break;
    case 'extension.widget':
      reduceExtensionWidget(session, event.payload);
      break;
    case 'extension.dialog':
      reduceExtensionDialog(session, event.payload);
      break;
    case 'extension.dialog.dismiss':
      reduceExtensionDialogDismiss(session, event.payload);
      break;
    case 'extension.ui':
      reduceExtensionUi(session, event.payload);
      break;
    case 'extension.app':
      reduceExtensionApp(session, event.payload);
      break;
    case 'extension.error':
      reduceExtensionError(session, event.payload);
      break;
    default: {
      // Exhaustiveness check: unknown event names are silently ignored
      // (they would have failed `isPiEvent` upstream anyway).
      const exhaustive: never = event;
      void exhaustive;
    }
  }

  const next: PiReducerState = {
    bySession: new Map(state.bySession),
    lastSequence: new Map(state.lastSequence),
  };
  next.bySession.set(event.sessionId, session);
  next.lastSequence.set(event.sessionId, event.sequence);
  return { state: next, didApply: true, sessionId: event.sessionId };
};

/**
 * Apply a list of events in order. Returns the final state, the total
 * number of applied events, and the number of skipped (out-of-order)
 * events.
 */
export const applyPiEvents = (
  state: PiReducerState,
  events: readonly PiSessionEvent[],
): { state: PiReducerState; applied: number; skipped: number } => {
  let applied = 0;
  let skipped = 0;
  let working = state;
  for (const event of events) {
    const result = applyPiEvent(working, event);
    working = result.state;
    if (result.didApply) applied += 1;
    else skipped += 1;
  }
  return { state: working, applied, skipped };
};
