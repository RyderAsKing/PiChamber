import React from 'react';
import type { MessageBodyProps } from './assistantMessageTypes';
import { UserMessageBody } from './UserMessageBody';
import { AssistantMessageBody } from './AssistantMessageBody';

export type { MessageBodyProps, AssistantMessageBodyProps } from './assistantMessageTypes';

const MessageBody = React.memo(({ isUser, ...props }: MessageBodyProps) => {
  if (isUser) {
    return (
      <UserMessageBody
        sessionId={props.sessionId}
        messageId={props.messageId}
        parts={props.parts}
        messageCreatedAt={props.messageCreatedAt}
        isMobile={props.isMobile}
        alwaysShowActions={props.alwaysShowActions}
        hasTouchInput={props.hasTouchInput}
        hasTextContent={props.hasTextContent}
        onCopyMessage={props.onCopyMessage}
        copiedMessage={props.copiedMessage}
        onShowPopup={props.onShowPopup}
        agentMention={props.agentMention}
        userActionsMode={props.userActionsMode}
        stickyUserHeaderEnabled={props.stickyUserHeaderEnabled}
      />
    );
  }

  return <AssistantMessageBody {...props} />;
});

export default MessageBody;
