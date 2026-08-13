import { create } from 'zustand';
import type { SessionWorktreeAttachment } from '@/stores/types/sessionTypes';

type WorktreeState = {
  attachments: Map<string, SessionWorktreeAttachment>;
  getAttachment: (sessionId: string) => SessionWorktreeAttachment | undefined;
  setAttachment: (sessionId: string, attachment: SessionWorktreeAttachment) => void;
  clearAttachment: (sessionId: string) => void;
};

export const useSessionWorktreeStore = create<WorktreeState>()((set, get) => ({
  attachments: new Map(),
  getAttachment: (sessionId) => get().attachments.get(sessionId),
  setAttachment: (sessionId, attachment) => {
    const next = new Map(get().attachments);
    next.set(sessionId, attachment);
    set({ attachments: next });
  },
  clearAttachment: (sessionId) => {
    const next = new Map(get().attachments);
    next.delete(sessionId);
    set({ attachments: next });
  },
}));
