import type { Part } from '@/lib/chat/types';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo } from './types';
import type { TurnGroupingContext } from '../lib/turns/types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';

export interface MessageBodyProps {
  sessionId?: string;
  messageId: string;
  parts: Part[];
  isUser: boolean;
  isMessageCompleted: boolean;
  isLatestMessage?: boolean;
  messageFinish?: string;
  messageCompletedAt?: number;
  messageCreatedAt?: number;
  durationMs?: number;

  isMobile: boolean;
  alwaysShowActions?: boolean;
  hasTouchInput?: boolean;
  onShowPopup: (content: ToolPopupContent) => void;
  streamPhase: StreamPhase;
  onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;

  /** Turn-level activity is rendered by the shared process rail. */
  hasTextContent?: boolean;
  onCopyMessage?: () => void | boolean | Promise<void | boolean>;
  copiedMessage?: boolean;
  onAuxiliaryContentComplete?: () => void;
  agentMention?: AgentMentionInfo;
  turnGroupingContext?: TurnGroupingContext;
  errorMessage?: string;
  errorVariant?: 'error' | 'info';
  userActionsMode?: 'inline' | 'external-content' | 'external-actions';
  footerProviderID?: string | null;
  footerModelName?: string;
  footerAgentName?: string;
  footerVariant?: string;
  isDarkTheme?: boolean;
}

export type AssistantMessageBodyProps = Omit<MessageBodyProps, 'isUser'>;
