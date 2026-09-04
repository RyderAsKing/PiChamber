import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface SidebarSpaceStore {
  /**
   * Space scoped in the left folder rail (`SidebarSpacesBar`) and project
   * list. `null` is the All sessions view. This is a view filter, not the
   * active context: selecting a session row never changes it, while folder
   * navigation (rail clicks, folder-cycle shortcuts) sets it explicitly.
   */
  selectedSpaceId: string | null;
  selectedWorktreePath: string | null;

  /** Focus a project space, dropping any worktree pin. */
  selectSpace: (id: string | null) => void;
  /** Focus a linked worktree row inside a project space. */
  selectWorktree: (projectId: string, worktreePath: string | null) => void;
  /** Return to the All sessions view. */
  clearSpaceSelection: () => void;
  /** Keep the project space, drop the worktree pin. */
  clearSelectedWorktree: () => void;
}

export const useSidebarSpaceStore = create<SidebarSpaceStore>()(
  devtools(
    (set) => ({
      selectedSpaceId: null,
      selectedWorktreePath: null,

      selectSpace: (id) => {
        set({ selectedSpaceId: id, selectedWorktreePath: null });
      },
      selectWorktree: (projectId, worktreePath) => {
        set({ selectedSpaceId: projectId, selectedWorktreePath: worktreePath });
      },
      clearSpaceSelection: () => {
        set({ selectedSpaceId: null, selectedWorktreePath: null });
      },
      clearSelectedWorktree: () => {
        set({ selectedWorktreePath: null });
      },
    }),
    { name: 'sidebar-space' },
  ),
);
