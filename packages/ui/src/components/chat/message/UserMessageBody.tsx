import React from 'react';
import type { Part } from '@/lib/chat/types';
import UserTextPart from './parts/UserTextPart';
import { MessageFilesDisplay } from '../FileAttachment';
import type { ToolPopupContent, AgentMentionInfo } from './types';
import { cn } from '@/lib/utils';
import { isEmptyTextPart, extractTextContent } from './partUtils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from '@/components/icon/Icon';
import { formatTimestampForDisplay } from './timeFormat';
import { MessageRevertAction } from './MessageRevertAction';
import { MessageForkAction } from './MessageForkAction';
import { UserShellActionPart, UserSubtaskPart } from './UserAuxiliaryParts';
import { isShellActionPart, isSubtaskPart } from './userAuxiliaryPartsModel';

const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const, transform: 'translateZ(0)' };

export interface UserMessageBodyProps {
  sessionId?: string | null;
  messageId: string;
  parts: Part[];
  messageCreatedAt?: number | null;
  isLatestMessage?: boolean;
  isMobile: boolean;
  alwaysShowActions?: boolean;
  hasTouchInput?: boolean;
  hasTextContent?: boolean;
  onCopyMessage?: () => void;
  copiedMessage?: boolean;
  onShowPopup: (content: ToolPopupContent) => void;
  agentMention?: AgentMentionInfo;
  userActionsMode?: 'inline' | 'external-content' | 'external-actions';
  stickyUserHeaderEnabled?: boolean;
}

export const UserMessageBody = React.memo(function UserMessageBody({
  sessionId,
  messageId,
  parts,
  messageCreatedAt,
  isLatestMessage = false,
  isMobile,
  alwaysShowActions = isMobile,
  hasTouchInput,
  hasTextContent,
  onCopyMessage,
  copiedMessage,
  onShowPopup,
  agentMention,
  userActionsMode = 'inline',
  stickyUserHeaderEnabled = true,
}: UserMessageBodyProps) {
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const [copyHintVisible, setCopyHintVisible] = React.useState(false);
  const copyHintTimeoutRef = React.useRef<number | null>(null);

  const userContentParts = React.useMemo(() => {
    return parts.filter((part) => {
      if (part.type === 'text') {
        return !isEmptyTextPart(part);
      }
      if (isSubtaskPart(part)) {
        return true;
      }
      if (isShellActionPart(part)) {
        return true;
      }
      return false;
    });
  }, [parts]);

  const mentionToken = agentMention?.token;
  let mentionInjected = false;

  const canCopyMessage = Boolean(onCopyMessage);
  const isMessageCopied = Boolean(copiedMessage);
  const isTouchContext = Boolean(hasTouchInput ?? isMobile);
  const hasCopyableText = Boolean(hasTextContent);
  const showUserContent = userActionsMode !== 'external-actions';
  const showUserActions = userActionsMode !== 'external-content';
  const useStickyScrollableUserContent =
    stickyUserHeaderEnabled && userActionsMode === 'inline';

  const clearCopyHintTimeout = React.useCallback(() => {
    if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(copyHintTimeoutRef.current);
      copyHintTimeoutRef.current = null;
    }
  }, []);

  const revealCopyHint = React.useCallback(() => {
    if (
      !isTouchContext ||
      !canCopyMessage ||
      !hasCopyableText ||
      typeof window === 'undefined'
    ) {
      return;
    }

    clearCopyHintTimeout();
    setCopyHintVisible(true);
    copyHintTimeoutRef.current = window.setTimeout(() => {
      setCopyHintVisible(false);
      copyHintTimeoutRef.current = null;
    }, 1800);
  }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

  React.useEffect(() => {
    if (!hasCopyableText) {
      setCopyHintVisible(false);
      clearCopyHintTimeout();
    }
  }, [clearCopyHintTimeout, hasCopyableText]);

  const handleCopyButtonClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!onCopyMessage || !hasCopyableText) {
        return;
      }

      event.stopPropagation();
      event.preventDefault();
      onCopyMessage();

      if (isTouchContext) {
        revealCopyHint();
      }
    },
    [hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint]
  );

  const timestamp = React.useMemo(() => {
    if (typeof messageCreatedAt !== 'number' || messageCreatedAt <= 0) return null;
    const formatted = formatTimestampForDisplay(
      messageCreatedAt,
      timeFormatPreference
    );
    return formatted.length > 0 ? formatted : null;
  }, [messageCreatedAt, timeFormatPreference]);

  const useInFlowUserActions = isMobile || alwaysShowActions;
  const actionsBlock = showUserActions ? (
    <div
      className={cn(
        'group/user-actions',
        useInFlowUserActions
          ? userActionsMode === 'inline'
            ? 'mt-2 mb-1 flex items-center justify-end'
            : stickyUserHeaderEnabled
            ? 'flex h-9 items-start justify-end pt-0'
            : 'flex h-11 items-start justify-end pt-0'
          : userActionsMode === 'inline'
          ? 'absolute top-full left-0 right-0 z-10 pt-5'
          : 'flex h-8 items-start justify-end pt-2'
      )}
    >
      <div
        className={cn(
          'flex items-center justify-end gap-1',
          isMobile
            ? userActionsMode === 'inline'
              ? 'translate-x-5'
              : 'translate-x-0'
            : userActionsMode === 'inline'
            ? 'translate-x-5'
            : 'translate-x-0',
          alwaysShowActions
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0 transition-opacity duration-150 group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-hover/user-actions:pointer-events-auto group-hover/user-actions:opacity-100 group-hover/user-shell:pointer-events-auto group-hover/user-shell:opacity-100'
        )}
      >
        {timestamp ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="mr-1 flex items-center gap-1 text-sm tabular-nums text-muted-foreground/60"
                aria-label={`Message time: ${timestamp}`}
              >
                <Icon name="time" className="h-3.5 w-3.5" />
                <span className="message-footer__label">{timestamp}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{timestamp}</TooltipContent>
          </Tooltip>
        ) : null}
        {!isLatestMessage ? (
          <MessageRevertAction
            sessionId={sessionId ?? null}
            messageId={messageId}
            size="user"
          />
        ) : null}
        <MessageForkAction
          sessionId={sessionId ?? null}
          messageId={messageId}
          size="user"
        />
        {canCopyMessage && hasCopyableText && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={'Copy message text'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handleCopyButtonClick}
                onFocus={() => setCopyHintVisible(true)}
                onBlur={() => {
                  if (!isMessageCopied) {
                    setCopyHintVisible(false);
                  }
                }}
              >
                {isMessageCopied ? (
                  <Icon
                    name="check"
                    className="h-3 w-3 text-[color:var(--status-success)]"
                  />
                ) : (
                  <Icon name="file-copy" className="h-3 w-3" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{'Copy message'}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  ) : null;

  if (!showUserContent) {
    return <>{actionsBlock}</>;
  }

  return (
    <div
      className="relative w-full group/message"
      style={CONTAIN_LAYOUT_STYLE}
      onTouchStart={
        isTouchContext && canCopyMessage && hasCopyableText
          ? revealCopyHint
          : undefined
      }
    >
      <div
        className={cn(
          'leading-relaxed text-foreground/90 text-base overflow-x-hidden',
          useStickyScrollableUserContent
            ? 'overflow-y-auto overscroll-contain scrollbar-none'
            : 'overflow-y-hidden'
        )}
        style={
          useStickyScrollableUserContent
            ? { maxHeight: 'calc(var(--chat-scroll-height, 100dvh) * 0.4)' }
            : undefined
        }
      >
        {userContentParts.map((part, index) => {
          if (isSubtaskPart(part)) {
            return (
              <React.Fragment key={part.id ?? `user-subtask-${index}`}>
                <UserSubtaskPart part={part} />
              </React.Fragment>
            );
          }

          if (isShellActionPart(part)) {
            return (
              <React.Fragment key={part.id ?? `user-shell-${index}`}>
                <UserShellActionPart part={part} />
              </React.Fragment>
            );
          }

          let mentionForPart: AgentMentionInfo | undefined;
          if (agentMention && mentionToken && !mentionInjected) {
            const candidateText = extractTextContent(part);
            if (candidateText.includes(mentionToken)) {
              mentionForPart = agentMention;
              mentionInjected = true;
            }
          }
          return (
            <React.Fragment key={part.id ?? `user-text-${index}`}>
              <UserTextPart
                part={part}
                messageId={messageId}
                isMobile={isMobile}
                agentMention={mentionForPart}
              />
            </React.Fragment>
          );
        })}
      </div>
      <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} compact />
      {actionsBlock}
    </div>
  );
});
