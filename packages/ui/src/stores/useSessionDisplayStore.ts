import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type SessionDisplayStore = {
  /** Project/recent zone headers stick to the top while their zone scrolls. */
  stickyZoneHeaders: boolean;
  toggleStickyZoneHeaders: () => void;
  showRecentSection: boolean;
  setShowRecentSection: (show: boolean) => void;
  toggleRecentSection: () => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore> & {
    displayMode?: string;
    sessionGroupingMode?: string;
    projectSortOrder?: string;
    showArchivedSessions?: boolean;
  };
  delete state.projectSortOrder;
  // Archived sessions no longer have a sidebar bucket to show or hide.
  delete state.showArchivedSessions;
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
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
    }),
    {
      name: 'pichamber:session-display-settings',
      version: 7,
      migrate: migrateSessionDisplayState,
    },
  ),
);
