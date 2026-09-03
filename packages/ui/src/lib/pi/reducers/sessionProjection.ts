import type {
  PiExtensionAppPayload,
  PiExtensionDialogPayload,
  PiExtensionPanelPayload,
} from '../protocol';
import { resolveExistingSessionComposerSelection } from '../thinking';
import type {
  PiAssistantMessage,
  PiAttachment,
  PiCompactionInfo,
  PiModelRef,
  PiRetryInfo,
  PiSessionLifecycleState,
  PiThinkingLevel,
  PiUserMessage,
} from '../types';
import type {
  PiProjectedMessage,
  PiProjectedMessagePart,
  PiProjectedSession,
  PiReducerMessage,
  PiReducerMessagePart,
  PiReducerSessionState,
  PiReducerState,
  ProjectSessionPrevious,
} from './reducerTypes';
import { createReducerState } from './reducerTypes';
import {
  getOrCreateSession,
  resolveParentId,
  uniqueSessionMessages,
} from './reducerHelpers';

const projectedPartsByReducerPart = new WeakMap<PiReducerMessagePart, PiProjectedMessagePart>();

export const projectReducerPart = (part: PiReducerMessagePart): PiProjectedMessagePart => {
  const cached = projectedPartsByReducerPart.get(part);
  if (cached) return cached;
  const projected: PiProjectedMessagePart = {
    id: part.id,
    type: part.type,
    text: part.text,
    streaming: part.streaming,
    ...(part.tool ? { tool: part.tool } : {}),
    ...(part.attachment ? { attachment: part.attachment } : {}),
    ...(part.file ? { file: part.file } : {}),
  };
  projectedPartsByReducerPart.set(part, projected);
  return projected;
};

export const recoveredErrorIdsFor = (
  session: PiReducerSessionState,
  sourceMessages: PiReducerMessage[],
): Set<string> => {
  const recoveredParents = new Set<string>();
  const recoveredErrorIds = new Set<string>();
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    const message = sourceMessages[index];
    if (!message || message.role !== 'assistant') continue;
    const parentId = resolveParentId(session, message.parentId);
    if (!parentId) continue;
    const hasVisibleContent = Boolean(
      message.text
      || message.thinking
      || (session.partOrder.get(message.id)?.length ?? 0) > 0,
    );
    if (message.error && !hasVisibleContent && recoveredParents.has(parentId)) {
      recoveredErrorIds.add(message.id);
      continue;
    }
    if (!message.error) recoveredParents.add(parentId);
  }
  return recoveredErrorIds;
};

export const canReuseProjectedMessage = (
  session: PiReducerSessionState,
  message: PiReducerMessage,
  previous: PiProjectedMessage,
  parts: PiProjectedMessagePart[],
): boolean => (
  previous.id === message.id
  && previous.role === message.role
  && previous.parentId === resolveParentId(session, message.parentId)
  && previous.text === message.text
  && previous.thinking === message.thinking
  && previous.streaming === message.streaming
  && previous.createdAt === message.createdAt
  && previous.durationMs === message.durationMs
  && previous.error === message.error
  && previous.model === message.model
  && previous.thinkingLevel === message.thinkingLevel
  && previous.usage === message.usage
  && previous.parts.length === parts.length
  && previous.parts.every((part, index) => part === parts[index])
);

export const projectReducerMessage = (
  session: PiReducerSessionState,
  message: PiReducerMessage,
  previousProjected?: PiProjectedMessage,
): PiProjectedMessage => {
  const order = session.partOrder.get(message.id) ?? [];
  const parts: PiProjectedMessagePart[] = [];
  for (const partId of order) {
    const part = session.parts.get(partId);
    if (part) parts.push(projectReducerPart(part));
  }
  if (previousProjected && canReuseProjectedMessage(session, message, previousProjected, parts)) {
    return previousProjected;
  }
  const parentId = resolveParentId(session, message.parentId);
  return {
    id: message.id,
    role: message.role,
    ...(parentId ? { parentId } : {}),
    ...(message.customType !== undefined ? { customType: message.customType } : {}),
    ...(message.data !== undefined ? { data: message.data } : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
    text: message.text,
    thinking: message.thinking,
    streaming: message.streaming,
    createdAt: message.createdAt,
    ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    parts,
  };
};

/**
 * Build an immutable projection of a session. Pass the previous projection
 * so unchanged historical messages and parts keep their object identity.
 * The projection does not include sequence bookkeeping so the UI cannot
 * accidentally leak it.
 */
export const projectSession = (
  session: PiReducerSessionState,
  previous?: ProjectSessionPrevious | null,
): PiProjectedSession => {
  const sourceMessages = uniqueSessionMessages(session);
  const recoveredErrorIds = recoveredErrorIdsFor(session, sourceMessages);
  const previousById = previous
    ? new Map(previous.projection.messages.map((message) => [message.id, message]))
    : null;

  const messages: PiProjectedMessage[] = [];
  for (const message of sourceMessages) {
    if (recoveredErrorIds.has(message.id)) continue;
    messages.push(projectReducerMessage(session, message, previousById?.get(message.id)));
  }

  if (
    previous
    && previous.projection.sessionId === session.sessionId
    && previous.projection.directory === session.directory
    && previous.projection.lifecycle === session.lifecycle
    && previous.projection.model === session.model
    && previous.projection.thinking === session.thinking
    && previous.projection.queue.steering === session.queue.steering
    && previous.projection.queue.followUp === session.queue.followUp
    && previous.projection.messages.length === messages.length
    && previous.projection.messages.every((message, index) => message === messages[index])
  ) {
    return previous.projection;
  }

  return {
    sessionId: session.sessionId,
    directory: session.directory,
    lifecycle: session.lifecycle,
    ...(session.model ? { model: session.model } : {}),
    ...(session.thinking ? { thinking: session.thinking } : {}),
    queue: { ...session.queue },
    messages,
  };
};

export const markHydratedLiveActivity = (
  session: PiReducerSessionState,
  options?: {
    isStreaming?: boolean;
    lifecycle?: PiSessionLifecycleState;
    inferFromRunningTools?: boolean;
    settleWhenIdle?: boolean;
    retry?: PiRetryInfo;
  },
): void => {
  const runningMessageIds: string[] = [];
  const runningPartIds: string[] = [];
  for (const [partId, part] of session.parts) {
    const toolState = part.tool?.state;
    if (part.type !== 'tool' || (toolState !== 'running' && toolState !== 'pending')) continue;
    runningPartIds.push(partId);
    const messageId = part.tool?.toolCallId ? session.toolsByCallId.get(part.tool.toolCallId) : undefined;
    if (messageId) runningMessageIds.push(messageId);
  }

  const live = options?.isStreaming === true
    || options?.lifecycle === 'busy'
    || options?.lifecycle === 'retry'
    || (options?.inferFromRunningTools === true && runningMessageIds.length > 0);
  if (!live) {
    session.retry = undefined;
    if (options?.settleWhenIdle) {
      session.streamingMessages = new Set();
      session.messages = new Map(session.messages);
      for (const [messageId, message] of session.messages) {
        if (message.streaming) session.messages.set(messageId, { ...message, streaming: false });
      }
    }
    return;
  }

  session.lifecycle = options?.lifecycle === 'retry' ? 'retry' : 'busy';
  session.retry = session.lifecycle === 'retry' ? options?.retry : undefined;
  session.streamingMessages = new Set(session.streamingMessages);
  for (const partId of runningPartIds) {
    const part = session.parts.get(partId);
    if (part) session.parts.set(partId, { ...part, streaming: true });
  }
  let targetId = runningMessageIds[runningMessageIds.length - 1];
  if (!targetId) {
    const messages = uniqueSessionMessages(session);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === 'assistant') {
        targetId = candidate.id;
        break;
      }
    }
  }
  if (!targetId) return;
  const message = session.messages.get(targetId);
  if (!message || message.role !== 'assistant') return;
  session.messages.set(targetId, { ...message, streaming: true });
  session.streamingMessages.add(targetId);
};

/**
 * Hydrate a session state from a `PiSessionDetailResponse`. The result is
 * ready to receive delta events with `fromSequence` strictly greater than
 * the last sequence returned by the response.
 */
export const hydrateSessionFromDetail = (
  detail: {
    session: {
      id: string;
      directory: string;
      model?: PiModelRef;
      thinking?: PiThinkingLevel;
    };
    lastSequence: number;
    isStreaming?: boolean;
    lifecycle?: PiSessionLifecycleState;
    retry?: PiRetryInfo;
    compaction?: PiCompactionInfo;
    extensionStatuses?: Array<{ key: string; text: string }>;
    extensionWidgets?: Array<{ key: string; lines: string[]; placement?: 'aboveEditor' | 'belowEditor' }>;
    extensionDialogs?: PiExtensionDialogPayload[];
    extensionPanels?: PiExtensionPanelPayload[];
    extensionApps?: PiExtensionAppPayload[];
    extensionTitle?: string;
    messages: Array<{
      message: PiUserMessage | PiAssistantMessage | {
        id: string;
        role: 'extension';
        createdAt: number;
        customType: string;
        parentId?: string;
        text?: string;
        data?: unknown;
        details?: unknown;
      };
      parts: Array<{
        id: string;
        index: number;
        type: 'text' | 'thinking' | 'tool' | 'attachment' | 'file';
        text?: string;
        toolCallId?: string;
        name?: string;
        input?: unknown;
        output?: unknown;
        error?: string;
        metadata?: Record<string, unknown>;
        isError?: boolean;
        state?: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
        startedAt?: number;
        endedAt?: number;
        attachment?: PiAttachment;
        mime?: string;
        filename?: string;
        url?: string;
      }>;
    }>;
  },
): { state: PiReducerState; session: PiReducerSessionState } => {
  const state = createReducerState();
  const session = getOrCreateSession(state, detail.session.id, detail.session.directory);
  session.lastSequence = detail.lastSequence;
  if (Array.isArray(detail.extensionStatuses)) {
    session.extensionStatuses = new Map(detail.extensionStatuses.map((entry) => [entry.key, entry.text]));
  }
  if (Array.isArray(detail.extensionWidgets)) {
    session.extensionWidgets = new Map(detail.extensionWidgets.map((entry) => [
      entry.key,
      { lines: entry.lines, placement: entry.placement === 'belowEditor' ? 'belowEditor' : 'aboveEditor' },
    ]));
  }
  if (Array.isArray(detail.extensionDialogs)) {
    session.extensionDialogs = detail.extensionDialogs.filter(
      (dialog) => typeof dialog.requestId === 'string' && typeof dialog.method === 'string' && typeof dialog.title === 'string',
    );
  }
  if (Array.isArray(detail.extensionPanels)) {
    session.extensionPanels = new Map(detail.extensionPanels
      .filter((panel) => typeof panel?.id === 'string' && panel.id.length > 0)
      .map((panel) => [panel.id, panel]));
  }
  if (Array.isArray(detail.extensionApps)) {
    session.extensionApps = new Map(detail.extensionApps
      .filter((app) => typeof app?.appId === 'string' && app.appId.length > 0)
      .map((app) => [app.appId, app]));
  }
  session.extensionTitle = detail.extensionTitle;

  for (const { message, parts } of detail.messages) {
    const isExtension = message.role === 'extension';
    const reducerMessage: PiReducerMessage = {
      id: message.id,
      sessionId: detail.session.id,
      directory: detail.session.directory,
      role: message.role,
      ...(isExtension && message.customType ? { customType: message.customType } : {}),
      ...(isExtension && message.data !== undefined ? { data: message.data } : {}),
      ...(isExtension && message.details !== undefined ? { details: message.details } : {}),
      ...(message.parentId ? { parentId: message.parentId } : {}),
      createdAt: message.createdAt,
      text: message.text ?? '',
      thinking: message.role === 'assistant' ? message.thinking ?? '' : '',
      streaming: false,
      ...(message.role === 'assistant' && message.durationMs !== undefined
        ? { durationMs: message.durationMs }
        : {}),
      ...(message.role === 'assistant' && message.error ? { error: message.error } : {}),
      ...(message.role === 'assistant' && message.model ? { model: message.model } : {}),
      ...(message.role === 'assistant' && message.thinkingLevel
        ? { thinkingLevel: message.thinkingLevel }
        : {}),
      ...(message.role === 'assistant' && message.usage ? { usage: message.usage } : {}),
    };
    session.messages.set(message.id, reducerMessage);
    const partOrder: string[] = [];
    for (const part of parts) {
      const reducerPart: PiReducerMessagePart = {
        id: part.id,
        index: part.index,
        type: part.type,
        text: part.text ?? '',
        streaming: false,
        ...(part.type === 'tool'
          ? {
              tool: {
                toolCallId: part.toolCallId ?? part.id,
                name: part.name ?? 'unknown',
                ...(part.input !== undefined ? { input: part.input } : {}),
                ...(part.output !== undefined ? { output: part.output } : {}),
                ...(typeof part.error === 'string' ? { error: part.error } : {}),
                ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
                ...(part.isError !== undefined ? { isError: part.isError } : {}),
                state: part.state ?? 'completed',
                ...(part.startedAt !== undefined ? { startedAt: part.startedAt } : {}),
                ...(part.endedAt !== undefined ? { endedAt: part.endedAt } : {}),
              },
            }
          : {}),
        ...(part.type === 'attachment' && part.attachment ? { attachment: part.attachment } : {}),
        ...(part.type === 'file'
          ? {
              file: {
                ...(typeof part.mime === 'string' ? { mime: part.mime } : {}),
                ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
                ...(typeof part.url === 'string' ? { url: part.url } : {}),
              },
            }
          : {}),
      };
      session.parts.set(part.id, reducerPart);
      partOrder.push(part.id);
      if (part.type === 'tool' && part.toolCallId) {
        session.toolsByCallId.set(part.toolCallId, message.id);
      }
    }
    session.partOrder.set(message.id, partOrder);
  }

  const resolved = resolveExistingSessionComposerSelection({
    model: detail.session.model,
    thinking: detail.session.thinking,
    messages: session.messages.values(),
  });
  if (resolved.model) session.model = resolved.model;
  if (resolved.thinking) session.thinking = resolved.thinking;
  session.compaction = detail.compaction;
  markHydratedLiveActivity(session, {
    ...(detail.isStreaming !== undefined ? { isStreaming: detail.isStreaming } : {}),
    ...(detail.lifecycle ? { lifecycle: detail.lifecycle } : {}),
    ...(detail.retry ? { retry: detail.retry } : {}),
    inferFromRunningTools: true,
  });

  state.lastSequence.set(detail.session.id, detail.lastSequence);
  return { state, session };
};
