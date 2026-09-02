import React from 'react';
import type { ToolPart as ToolPartType } from '@/lib/chat/types';
import ToolPart from './parts/ToolPart';
import AssistantTextPart from './parts/AssistantTextPart';
import ReasoningPart from './parts/ReasoningPart';
import { MessageFilesDisplay } from '../FileAttachment';
import { TurnChangedFilesDropdown } from '../TurnChangedFilesDropdown';
import { cn } from '@/lib/utils';
import { filterRenderableAssistantParts } from './partUtils';
import { FadeInOnReveal } from './FadeInOnReveal';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { TextSelectionMenu } from './TextSelectionMenu';
import { useChatSurfaceMode } from '@/components/chat/chatSurfaceContext';
import { Icon } from '@/components/icon/Icon';
import { ToolRevealOnMount } from './parts/ToolRevealOnMount';
import { StaticToolRow } from './parts/StaticToolRow';
import { isExpandableTool } from './parts/toolRenderUtils';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { getAgentColor } from '@/lib/agentColors';
import { AssistantMessageActionButtons } from './AssistantMessageActionButtons';
import { TurnChangedFilePills } from './TurnChangedFilesPills';
import type { StreamPhase } from './types';
import type { AssistantMessageBodyProps } from './assistantMessageTypes';
import { shareMessageAsImage } from './shareMessageAsImage';
import { useAssistantMessageLifecycle } from './useAssistantMessageLifecycle';

const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const, transform: 'translateZ(0)' };
const MESSAGE_FOOTER_CONTAINER_STYLE = {
  containerType: 'inline-size' as const,
  containerName: 'message-footer',
};
const INLINE_MESSAGE_ACTIONS_CLASS_NAME = 'mt-2 mb-1 flex items-center justify-start gap-1.5';

export const AssistantMessageBody = React.memo(
  ({
    sessionId,
    messageId,
    parts,
    isMessageCompleted,
    messageFinish,
    messageCompletedAt,
    messageCreatedAt,
    durationMs,
    isLatestMessage = false,

    isMobile,
    alwaysShowActions,
    hasTouchInput,
    expandedTools,
    onToggleTool,
    onShowPopup,
    streamPhase: _streamPhase,
    allowAnimation: _allowAnimation,
    onContentChange,
    hasTextContent = false,
    onCopyMessage,
    onAuxiliaryContentComplete,
    showReasoningTraces = false,
    turnGroupingContext,
    errorMessage,
    errorVariant = 'error',
    footerProviderID,
    footerModelName,
    footerAgentName,
    footerVariant,
    isDarkTheme = false,
  }: AssistantMessageBodyProps) => {
    const chatSurfaceMode = useChatSurfaceMode();
    const streamPhase = _streamPhase;
    void _allowAnimation;
    const messageContentRef = React.useRef<HTMLDivElement>(null);
    const messageTextContentRef = React.useRef<HTMLDivElement>(null);

    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const alwaysShowMessageActions = Boolean(alwaysShowActions ?? isMobile);
    const {
      src: footerLogoSrc,
      onError: handleFooterLogoError,
      hasLogo: footerHasLogo,
    } = useProviderLogo(footerProviderID ?? null);

    const visibleParts = React.useMemo(() => {
      return filterRenderableAssistantParts(parts);
    }, [parts]);

    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const getDirectoryForSession = useSessionUIStore((state) => state.getDirectoryForSession);
    const effectiveDirectory = useEffectiveDirectory();
    const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
    const collapseThinkingByDefault = useUIStore((state) => state.collapseThinkingByDefault);
    const showSplitAssistantMessageActions = useUIStore(
      (state) => state.showSplitAssistantMessageActions,
    );
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const openContextPreview = useUIStore((state) => state.openContextPreview);

    const {
      animatedToolIdsLookup,
      messagePreviewUrl,
      isLastAssistantInTurn,
      isTurnWorking,
      hasStopFinish,
      awaitingMessageCompletion,
      turnDurationText,
      footerTimestamp,
    } = useAssistantMessageLifecycle({
      messageId,
      visibleParts,
      isMessageCompleted,
      messageFinish,
      messageCompletedAt,
      messageCreatedAt,
      durationMs,
      turnGroupingContext,
      errorMessage,
      isMobile,
      isMiniChatSurface,
      timeFormatPreference,
      onAuxiliaryContentComplete,
      onContentChange,
    });

    const effectiveStreamPhase: StreamPhase = hasStopFinish ? 'completed' : streamPhase;
    const hasCopyableText = Boolean(hasTextContent) && !awaitingMessageCompletion;

    const handleShareImage = React.useCallback(
      async (requestedSourceElement?: HTMLElement | null): Promise<void> => {
        const sourceElement =
          requestedSourceElement ?? messageTextContentRef.current ?? messageContentRef.current;
        await shareMessageAsImage(messageId, sourceElement);
      },
      [messageId],
    );

    const showErrorMessage = Boolean(errorMessage);
    const errorIconName = errorVariant === 'info' ? 'information' : 'error-warning';
    const shouldShowMessageActions = hasCopyableText;
    const shouldShowTurnFooter =
      isLastAssistantInTurn && (hasTextContent || Boolean(errorMessage)) && !isTurnWorking;
    const shouldShowStandaloneMessageActions =
      showSplitAssistantMessageActions && shouldShowMessageActions && !shouldShowTurnFooter;

    const messageActionButtons = React.useMemo(
      () => (
        <AssistantMessageActionButtons
          hasCopyableText={hasCopyableText}
          isTouchContext={isTouchContext}
          onCopyMessage={onCopyMessage}
          onShareImage={handleShareImage}
          sessionId={sessionId}
          messageId={messageId}
          isLatestMessage={isLatestMessage}
        />
      ),
      [
        handleShareImage,
        hasCopyableText,
        isLatestMessage,
        isTouchContext,
        messageId,
        onCopyMessage,
        sessionId,
      ],
    );

    const lastRenderableTextPartIndex = React.useMemo(() => {
      if (!shouldShowStandaloneMessageActions) {
        return -1;
      }

      let lastIndex = -1;
      for (let index = 0; index < visibleParts.length; index += 1) {
        const part = visibleParts[index];
        if (!part || part.type !== 'text') {
          continue;
        }
        lastIndex = index;
      }

      return lastIndex;
    }, [shouldShowStandaloneMessageActions, visibleParts]);

    const shouldRenderStandaloneActionsAfterContent =
      shouldShowStandaloneMessageActions && lastRenderableTextPartIndex < 0;

    const renderedParts = React.useMemo(() => {
      const rendered: React.ReactNode[] = [];

      let i = 0;
      while (i < visibleParts.length) {
        const part = visibleParts[i];

        if (part.type === 'text') {
          rendered.push(
            <div
              key={`assistant-text-${messageId}-${i}`}
              ref={messageTextContentRef}
              data-message-text-export-source="true"
            >
              <AssistantTextPart
                part={part}
                sessionId={sessionId}
                messageId={messageId}
                streamPhase={effectiveStreamPhase}
                onContentChange={onContentChange}
                onShowPopup={onShowPopup}
              />
            </div>,
          );
          if (shouldShowStandaloneMessageActions && i === lastRenderableTextPartIndex) {
            rendered.push(
              <div
                key={`message-actions-${messageId}`}
                className={INLINE_MESSAGE_ACTIONS_CLASS_NAME}
                data-message-actions="true"
              >
                <div className="flex items-center gap-1.5" data-message-action-group="true">
                  {messageActionButtons}
                </div>
              </div>,
            );
          }
          i++;
          continue;
        }

        if (part.type === 'reasoning') {
          if (showReasoningTraces) {
            if (!collapsibleThinkingBlocks) {
              rendered.push(
                <AssistantTextPart
                  key={`reasoning-${messageId}-${i}`}
                  part={part}
                  sessionId={sessionId}
                  messageId={messageId}
                  streamPhase={effectiveStreamPhase}
                  onContentChange={onContentChange}
                  onShowPopup={onShowPopup}
                />,
              );
            } else {
              rendered.push(
                <ReasoningPart
                  key={`reasoning-${messageId}-${i}`}
                  part={part}
                  messageId={messageId}
                  streamPhase={effectiveStreamPhase}
                  onContentChange={onContentChange}
                  collapseByDefault={collapseThinkingByDefault}
                />,
              );
            }
          }
          i++;
          continue;
        }

        if (part.type === 'tool') {
          const toolPart = part as ToolPartType;
          const toolName = toolPart.tool?.toLowerCase() ?? '';

          if (isExpandableTool(toolName)) {
            rendered.push(
              <FadeInOnReveal key={`tool-${toolPart.id}`}>
                <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                  <ToolPart
                    part={toolPart}
                    isExpanded={expandedTools.has(toolPart.id)}
                    onToggle={onToggleTool}
                    isMobile={isMobile}
                    alwaysShowActions={alwaysShowMessageActions}
                    onContentChange={onContentChange}
                    onShowPopup={onShowPopup}
                    animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                  />
                </ToolRevealOnMount>
              </FadeInOnReveal>,
            );
            i++;
            continue;
          }

          rendered.push(
            <FadeInOnReveal key={`static-tools-${toolPart.id}`}>
              <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                <StaticToolRow
                  toolName={toolName}
                  activities={[
                    {
                      id: toolPart.id,
                      turnId: '',
                      messageId,
                      partIndex: 0,
                      part: toolPart,
                      kind: 'tool' as const,
                    },
                  ]}
                  animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                />
              </ToolRevealOnMount>
            </FadeInOnReveal>,
          );
          i++;
          continue;
        }

        i++;
      }

      return rendered;
    }, [
      alwaysShowMessageActions,
      animatedToolIdsLookup,
      collapsibleThinkingBlocks,
      collapseThinkingByDefault,
      expandedTools,
      isMobile,
      lastRenderableTextPartIndex,
      messageId,
      messageActionButtons,
      sessionId,
      onContentChange,
      onShowPopup,
      onToggleTool,
      shouldShowStandaloneMessageActions,
      effectiveStreamPhase,
      showReasoningTraces,
      visibleParts,
    ]);

    const footerTimestampClassName =
      'text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1';
    const canOpenMessagePreview = !isMiniChatSurface && !isMobile;

    const finalTurnActionButtons = (
      <>
        {canOpenMessagePreview && messagePreviewUrl ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                aria-label={'Open preview'}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  const directory =
                    effectiveDirectory ??
                    (currentSessionId ? getDirectoryForSession(currentSessionId) : null);
                  if (!directory) {
                    return;
                  }
                  openContextPreview(directory, messagePreviewUrl);
                }}
              >
                <Icon name="global" className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{'Open preview'}</TooltipContent>
          </Tooltip>
        ) : null}
      </>
    );

    return (
      <div
        ref={messageContentRef}
        data-message-text-export-root="true"
        className={cn('relative w-full group/message')}
        style={CONTAIN_LAYOUT_STYLE}
      >
        <TextSelectionMenu containerRef={messageContentRef} />
        <div>
          <div className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0">
            {renderedParts}
            {showErrorMessage && (
              <FadeInOnReveal key="assistant-error">
                <div
                  className={cn(
                    'group/assistant-text relative mt-3 p-3 rounded-lg border break-words max-w-full',
                    errorVariant === 'info'
                      ? 'bg-[var(--status-info-background)] border-[var(--status-info-border)]'
                      : 'bg-[var(--status-error-background)] border-[var(--status-error-border)]',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon
                      name={errorIconName}
                      className={cn(
                        'h-4 w-4 shrink-0',
                        errorVariant === 'info'
                          ? 'text-[var(--status-info)]'
                          : 'text-[var(--status-error)]',
                      )}
                    />
                    <div className="min-w-0 flex-1 break-words">
                      <SimpleMarkdownRenderer
                        content={errorMessage ?? ''}
                        onShowPopup={onShowPopup}
                        className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
                        enableFileReferences={false}
                      />
                    </div>
                  </div>
                </div>
              </FadeInOnReveal>
            )}
          </div>
          <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} />
          {shouldRenderStandaloneActionsAfterContent && (
            <div
              className={INLINE_MESSAGE_ACTIONS_CLASS_NAME}
              data-message-actions="true"
            >
              <div
                className="flex items-center gap-1.5"
                data-message-action-group="true"
              >
                {messageActionButtons}
              </div>
            </div>
          )}
          {shouldShowTurnFooter && (
            <div
              className="mt-2 mb-1 flex flex-wrap items-center justify-start gap-x-3 gap-y-1.5"
              style={MESSAGE_FOOTER_CONTAINER_STYLE}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground/60">
                {footerModelName ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    {footerHasLogo && footerLogoSrc ? (
                      <img
                        src={footerLogoSrc}
                        alt=""
                        className="h-3.5 w-3.5 flex-shrink-0"
                        style={{
                          filter: isDarkTheme
                            ? 'brightness(0.9) contrast(1.1) invert(1)'
                            : 'brightness(0.9) contrast(1.1)',
                        }}
                        onError={handleFooterLogoError}
                      />
                    ) : (
                      <Icon
                        name="brain-ai-3"
                        className="h-3.5 w-3.5 flex-shrink-0"
                        style={{ color: `var(${getAgentColor(footerAgentName).var})` }}
                      />
                    )}
                    <span className="truncate">{footerModelName}</span>
                  </span>
                ) : null}
                {footerVariant && !['default', 'none'].includes(footerVariant.toLowerCase()) ? (
                  <span className="flex items-center gap-1">
                    <Icon name="brain-ai-3" className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="message-footer__label">
                      {footerVariant[0].toLowerCase() + footerVariant.slice(1)}
                    </span>
                  </span>
                ) : null}
                {footerAgentName ? (
                  <span className="flex items-center gap-1">
                    <Icon name="ai-agent" className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="message-footer__label">{footerAgentName}</span>
                  </span>
                ) : null}
                {turnDurationText ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1">
                        <Icon name="hourglass" className="h-3.5 w-3.5" />
                        <span className="message-footer__label">{turnDurationText}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{turnDurationText}</TooltipContent>
                  </Tooltip>
                ) : null}
                {footerTimestamp ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={footerTimestampClassName}
                        aria-label={`Message time: ${footerTimestamp}`}
                      >
                        <Icon name="time" className="h-3.5 w-3.5" />
                        <span className="message-footer__label">{footerTimestamp}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{footerTimestamp}</TooltipContent>
                  </Tooltip>
                ) : null}
                {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                  <TurnChangedFilesDropdown activityParts={turnGroupingContext?.activityParts} />
                ) : null}
                {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                  <TurnChangedFilePills
                    files={turnGroupingContext?.changedFiles}
                    isInteractive={turnGroupingContext?.isLatestTurn === true}
                  />
                ) : null}
              </div>
              <div
                className={cn(
                  'flex items-center gap-1.5',
                  alwaysShowMessageActions || isTouchContext
                    ? undefined
                    : 'pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100',
                )}
                data-message-action-group="true"
              >
                {messageActionButtons}
                {finalTurnActionButtons}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);
