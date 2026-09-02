import type { Message, Part } from '@/lib/chat/types';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import {
  isLikelyProviderAuthFailure,
  PROVIDER_AUTH_FAILURE_MESSAGE,
} from '@/lib/messages/providerAuthError';

export interface AssistantErrorInfo {
  text: string;
  variant: 'error' | 'info';
}

export const getAssistantError = (
  message: Message
): AssistantErrorInfo | undefined => {
  const errorInfo = (message as { error?: unknown } | undefined)?.error as
    | {
        data?: {
          message?: unknown;
          phase?: unknown;
          reason?: unknown;
          attempt?: unknown;
          maxAttempts?: unknown;
          tokensBefore?: unknown;
          estimatedTokensAfter?: unknown;
          willRetry?: unknown;
        };
        message?: unknown;
        name?: unknown;
      }
    | undefined;

  if (!errorInfo) {
    return undefined;
  }

  const dataMessage =
    typeof errorInfo.data?.message === 'string'
      ? errorInfo.data.message
      : undefined;
  const errorMessage =
    typeof errorInfo.message === 'string' ? errorInfo.message : undefined;
  const errorName =
    typeof errorInfo.name === 'string' ? errorInfo.name : undefined;
  const detail = dataMessage || errorMessage || errorName;
  if (!detail) {
    return undefined;
  }

  if (errorName === 'SessionRetry') {
    return {
      text: `Retrying after an error:\n\`${detail}\``,
      variant: 'info',
    };
  }

  if (errorName === 'SessionCompaction') {
    const phase = errorInfo.data?.phase;
    const reason = errorInfo.data?.reason;
    if (phase === 'running') {
      const text =
        reason === 'threshold'
          ? 'Context is nearly full. Compacting automatically...'
          : reason === 'overflow'
          ? 'Context limit reached. Compacting before retrying...'
          : 'Compacting session context...';
      return { text, variant: 'info' };
    }
    if (phase === 'retrying') {
      const attempt =
        typeof errorInfo.data?.attempt === 'number'
          ? errorInfo.data.attempt
          : undefined;
      const maxAttempts =
        typeof errorInfo.data?.maxAttempts === 'number'
          ? errorInfo.data.maxAttempts
          : undefined;
      const count =
        attempt && maxAttempts ? ` (${attempt}/${maxAttempts})` : '';
      const reasonText =
        typeof errorInfo.data?.message === 'string' &&
        errorInfo.data.message.trim()
          ? `\n\`${errorInfo.data.message.trim()}\``
          : '';
      return {
        text: `Compaction failed temporarily. Retrying${count}...${reasonText}`,
        variant: 'info',
      };
    }
    if (phase === 'completed') {
      const before =
        typeof errorInfo.data?.tokensBefore === 'number'
          ? errorInfo.data.tokensBefore
          : undefined;
      const after =
        typeof errorInfo.data?.estimatedTokensAfter === 'number'
          ? errorInfo.data.estimatedTokensAfter
          : undefined;
      const reduction =
        before !== undefined && after !== undefined
          ? `\n${before.toLocaleString()} → approximately ${after.toLocaleString()} tokens`
          : '';
      const retryingTurn =
        errorInfo.data?.willRetry === true
          ? '\nRetrying the interrupted turn.'
          : '';
      return {
        text: `Session compacted${reduction}${retryingTurn}`,
        variant: 'info',
      };
    }
    if (phase === 'aborted') {
      return { text: 'Compaction stopped.', variant: 'info' };
    }
    const failure =
      typeof errorInfo.data?.message === 'string' &&
      errorInfo.data.message.trim()
        ? `\n\`${errorInfo.data.message.trim()}\``
        : '';
    return { text: `Compaction failed.${failure}`, variant: 'error' };
  }

  if (isLikelyProviderAuthFailure(detail)) {
    return {
      text: PROVIDER_AUTH_FAILURE_MESSAGE,
      variant: 'error',
    };
  }

  if (detail.trim().toLowerCase() === 'aborted') {
    return {
      text: 'The running turn was stopped before the next message could be sent.',
      variant: 'info',
    };
  }

  return {
    text: `Failed to send message with error:\n\`${detail}\``,
    variant: 'error',
  };
};

export const extractMessageTextContent = ({
  isUser,
  displayParts,
  assistantErrorText,
}: {
  isUser: boolean;
  displayParts: Part[];
  assistantErrorText?: string;
}): string => {
  if (isUser) {
    const shellOutputs = displayParts
      .filter(
        (
          part
        ): part is Part & {
          type: 'text';
          shellAction?: { output?: unknown };
        } => part.type === 'text'
      )
      .map((part) => {
        const output = part.shellAction?.output;
        return typeof output === 'string' ? output.trim() : '';
      })
      .filter((output) => output.length > 0);

    if (shellOutputs.length > 0) {
      return shellOutputs.join('\n\n');
    }

    const shellCommands = displayParts
      .filter(
        (
          part
        ): part is Part & {
          type: 'text';
          shellAction?: { command?: unknown };
        } => part.type === 'text'
      )
      .map((part) => {
        const command = part.shellAction?.command;
        return typeof command === 'string' ? command.trim() : '';
      })
      .filter((command) => command.length > 0);

    if (shellCommands.length > 0) {
      return shellCommands.join('\n');
    }

    const textParts = displayParts
      .filter(
        (
          part
        ): part is Part & {
          type: 'text';
          text?: string;
          content?: string;
        } => part.type === 'text'
      )
      .map((part) => {
        const text = part.text || part.content || '';
        return text.trim();
      })
      .filter((text) => text.length > 0);

    const combined = textParts.join('\n');
    return combined.replace(/\n\s*\n+/g, '\n');
  }

  if (assistantErrorText && assistantErrorText.trim().length > 0) {
    return assistantErrorText;
  }

  return flattenAssistantTextParts(displayParts);
};
