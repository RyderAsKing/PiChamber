import type { Part } from '@/lib/chat/types';
import type { ChatMessageEntry, TurnRecord } from './turns/types';
import { USER_SHELL_MARKER, type ShellBridgeDetails } from './shellBridge';

export const resolveMessageRole = (message: ChatMessageEntry): string | null => {
  const info = message.info as unknown as {
    clientRole?: string | null | undefined;
    role?: string | null | undefined;
  };
  return (
    (typeof info.clientRole === 'string' ? info.clientRole : null) ??
    (typeof info.role === 'string' ? info.role : null) ??
    null
  );
};

export const isSessionRetryMessage = (message: ChatMessageEntry): boolean => {
  const error = (message.info as { error?: { name?: unknown } }).error;
  return error?.name === 'SessionRetry';
};

export const getPartText = (part: Part): string => {
  const text = (part as { text?: unknown }).text;
  if (typeof text === 'string') {
    return text;
  }
  const content = (part as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  return '';
};

export const getMessageId = (message: ChatMessageEntry | undefined): string | null => {
  if (!message) return null;
  const id = (message.info as unknown as { id?: unknown }).id;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

export const getMessageParentId = (message: ChatMessageEntry): string | null => {
  const parentID = (message.info as unknown as { parentID?: unknown }).parentID;
  return typeof parentID === 'string' && parentID.trim().length > 0 ? parentID : null;
};

export const normalizeCompactionSummaryMessage = (
  message: ChatMessageEntry,
  compactionCommandIds: Set<string>,
): ChatMessageEntry => {
  const role = resolveMessageRole(message);
  if (role !== 'system') {
    return message;
  }

  const parentID = getMessageParentId(message);
  if (!parentID || !compactionCommandIds.has(parentID)) {
    return message;
  }

  const info = message.info as unknown as { clientRole?: string | null | undefined };
  if (info.clientRole === 'assistant') {
    return message;
  }

  return {
    ...message,
    info: {
      ...(message.info as unknown as Record<string, unknown>),
      clientRole: 'assistant',
    } as unknown as typeof message.info,
  };
};

export const isUserSubtaskMessage = (message: ChatMessageEntry | undefined): boolean => {
  if (!message) return false;
  if (resolveMessageRole(message) !== 'user') return false;
  return message.parts.some((part) => part?.type === 'subtask');
};

export const isInsideStuckSticky = (
  node: HTMLElement,
  container: HTMLElement,
  containerTop: number,
): boolean => {
  if (typeof window === 'undefined') return false;

  let current: HTMLElement | null = node;
  while (current && current !== container) {
    const computed = window.getComputedStyle(current);
    if (computed.position === 'sticky' && current.getBoundingClientRect().top <= containerTop + 1) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
};

export const readTaskSessionId = (toolPart: Part): string | null => {
  const partRecord = toolPart as unknown as {
    state?: {
      metadata?: {
        sessionId?: unknown;
        sessionID?: unknown;
      };
      output?: unknown;
    };
  };
  const metadata = partRecord.state?.metadata;
  const fromMetadata =
    (typeof metadata?.sessionID === 'string' && metadata.sessionID.trim().length > 0
      ? metadata.sessionID.trim()
      : null) ??
    (typeof metadata?.sessionId === 'string' && metadata.sessionId.trim().length > 0
      ? metadata.sessionId.trim()
      : null);
  if (fromMetadata) return fromMetadata;

  const output = partRecord.state?.output;
  if (typeof output === 'string') {
    const match = output.match(/task_id\s*:\s*([^\s<"']+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};

export const isSyntheticSubtaskBridgeAssistant = (
  message: ChatMessageEntry,
): { hide: boolean; taskSessionId: string | null } => {
  if (resolveMessageRole(message) !== 'assistant') {
    return { hide: false, taskSessionId: null };
  }

  if (message.parts.length !== 1) {
    return { hide: false, taskSessionId: null };
  }

  const onlyPart = message.parts[0] as unknown as
    | {
        type?: unknown;
        tool?: unknown;
      }
    | null
    | undefined;

  if (onlyPart?.type !== 'tool') {
    return { hide: false, taskSessionId: null };
  }

  const toolName = typeof onlyPart.tool === 'string' ? onlyPart.tool.toLowerCase() : '';
  if (toolName !== 'task') {
    return { hide: false, taskSessionId: null };
  }

  return {
    hide: true,
    taskSessionId: readTaskSessionId(message.parts[0]),
  };
};

export const withSubtaskSessionId = (
  message: ChatMessageEntry,
  taskSessionId: string | null,
): ChatMessageEntry => {
  if (!taskSessionId) return message;
  const nextParts = message.parts.map((part) => {
    if (part?.type !== 'subtask') return part;
    const existing = (part as unknown as { taskSessionID?: unknown }).taskSessionID;
    if (typeof existing === 'string' && existing.trim().length > 0) return part;
    return {
      ...part,
      taskSessionID: taskSessionId,
    } as Part;
  });

  return {
    ...message,
    parts: nextParts,
  };
};

export const withShellBridgeDetails = (
  message: ChatMessageEntry,
  details: ShellBridgeDetails | null,
): ChatMessageEntry => {
  const command = typeof details?.command === 'string' ? details.command.trim() : '';
  const output = typeof details?.output === 'string' ? details.output : '';
  const status = typeof details?.status === 'string' ? details.status.trim() : '';

  const nextParts: Part[] = [];
  let injected = false;

  for (const part of message.parts) {
    if (!injected && part?.type === 'text') {
      const text = (part as unknown as { text?: unknown }).text;
      const synthetic = (part as unknown as { synthetic?: unknown }).synthetic;
      if (
        synthetic === true &&
        typeof text === 'string' &&
        text.trim().startsWith(USER_SHELL_MARKER)
      ) {
        nextParts.push({
          type: 'text',
          text: '/shell',
          shellAction: {
            ...(command ? { command } : {}),
            ...(output ? { output } : {}),
            ...(status ? { status } : {}),
          },
        } as unknown as Part);
        injected = true;
        continue;
      }
    }
    nextParts.push(part);
  }

  if (!injected) {
    nextParts.push({
      type: 'text',
      text: '/shell',
      shellAction: {
        ...(command ? { command } : {}),
        ...(output ? { output } : {}),
        ...(status ? { status } : {}),
      },
    } as unknown as Part);
  }

  return {
    ...message,
    parts: nextParts,
  };
};

export const turnContainsMessageId = (
  turn: TurnRecord,
  messageId: string | null | undefined,
): boolean => {
  if (!messageId) {
    return false;
  }

  if (turn.userMessage.info.id === messageId) {
    return true;
  }

  return turn.assistantMessages.some((assistant) => assistant.info.id === messageId);
};
