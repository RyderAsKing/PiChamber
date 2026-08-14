import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Expand/collapse state for the mobile sessions sheet tree.
 *
 * Stores only explicit user overrides, keyed by project id (projects).
 * A missing key means "use the default": projects start expanded.
 */
type MobileSessionTreeStore = {
  projectExpanded: Record<string, boolean>;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
};

export const useMobileSessionTreeStore = create<MobileSessionTreeStore>()(
  persist(
    (set) => ({
      projectExpanded: {},
      setProjectExpanded: (projectId, expanded) =>
        set((state) => ({ projectExpanded: { ...state.projectExpanded, [projectId]: expanded } })),
    }),
    {
      name: 'mobile-session-tree',
    },
  ),
);
