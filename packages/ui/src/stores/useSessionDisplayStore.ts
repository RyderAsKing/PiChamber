import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type SessionDisplayStore = {
  /** Project/recent zone headers stick to the top while their zone scrolls. */
  stickyZoneHeaders: boolean;
  toggleStickyZoneHeaders: () => void;
  showRecentSection: boolean;
  // VS Code only: the compact webview keeps archived buckets inline because it
  // has no room for the full Archive dialog. Web/desktop ignore this flag and
  // always route archived sessions to the Archive dialog instead.
  showArchivedSessions: boolean;
  setShowRecentSection: (show: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleRecentSection: () => void;
  toggleArchivedSessions: () => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
    sessionGroupingMode?: string;
    projectSortOrder?: string;
  };
  delete state.projectSortOrder;
  if (version < 4) {
    delete state.displayMode;
  }
  if (version < 5) {
    delete state.sessionGroupingMode;
  }
  return state;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      stickyZoneHeaders: true,
      toggleStickyZoneHeaders: () => set((state) => ({ stickyZoneHeaders: !state.stickyZoneHeaders })),
      showRecentSection: true,
      showArchivedSessions: false,
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
    }),
    {
      name: 'pichamber:session-display-settings',
      version: 6,
      migrate: migrateSessionDisplayState,
    },
  ),
);
