import React from 'react';

export type ChatSurfaceMode = 'default' | 'mini-chat';

export const ChatSurfaceContext = React.createContext<ChatSurfaceMode>('default');

export const useChatSurfaceMode = (): ChatSurfaceMode => React.useContext(ChatSurfaceContext);
