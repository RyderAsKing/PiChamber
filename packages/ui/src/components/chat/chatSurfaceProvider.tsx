import React from 'react';
import { ChatSurfaceContext, type ChatSurfaceMode } from './chatSurfaceContext';

export const ChatSurfaceProvider: React.FC<{ mode: ChatSurfaceMode; children: React.ReactNode }> = ({ mode, children }) => (
  <ChatSurfaceContext.Provider value={mode}>{children}</ChatSurfaceContext.Provider>
);
