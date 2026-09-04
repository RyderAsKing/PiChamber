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
  copiedCode: string | null;
  onCopyCode: (code: string) => void;
  expandedTools: Set<string>;
  onToggleTool: (toolId: string) => void;
  onShowPopup: (content: ToolPopupContent) => void;
  streamPhase: StreamPhase;
  allowAnimation: boolean;
  onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;

  shouldShowHeader?: boolean;
  /** Turn-level activity is rendered by the shared process rail. */
  hideAssistantActivity?: boolean;
  hasTextContent?: boolean;
  onCopyMessage?: () => void | boolean | Promise<void | boolean>;
  copiedMessage?: boolean;
  onAuxiliaryContentComplete?: () => void;
  showReasoningTraces?: boolean;
  agentMention?: AgentMentionInfo;
  turnGroupingContext?: TurnGroupingContext;
  errorMessage?: string;
  errorVariant?: 'error' | 'info';
  userActionsMode?: 'inline' | 'external-content' | 'external-actions';
  stickyUserHeaderEnabled?: boolean;
  footerProviderID?: string | null;
  footerModelName?: string;
  footerAgentName?: string;
  footerVariant?: string;
  isDarkTheme?: boolean;
}

export type AssistantMessageBodyProps = Omit<MessageBodyProps, 'isUser'>;
