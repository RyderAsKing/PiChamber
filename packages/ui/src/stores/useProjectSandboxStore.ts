import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { piClient } from '@/lib/pi/client';
import type {
  PiProjectSandboxSetting,
  PiProjectSandboxState,
  PiSandboxLauncherStatus,
} from '@/lib/pi/protocol';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

/**
 * Project sandboxes (#242) as the server reports them: launcher status and
 * each project's sandbox setting. The server is authoritative; this store
 * only caches its last answer for Settings and the terminal note.
 *
 * `status` separates "never loaded" and "failed" from a loaded empty list,
 * so a failed fetch never reads as "no project is sandboxed". A runtime
 * switch drops everything, and answers that arrive after one are ignored.
 */
type ProjectSandboxLoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

interface ProjectSandboxStoreState {
  launchers: PiSandboxLauncherStatus[] | null;
  launchersStatus: ProjectSandboxLoadStatus;
  rechecking: boolean;
  projects: Record<string, PiProjectSandboxState>;
  projectsStatus: ProjectSandboxLoadStatus;
  /** Projects with a save in flight. */
  saving: Record<string, true>;
  /** Last save error per project, cleared by the next successful save. */
  saveErrors: Record<string, string>;
  loadLaunchers: () => Promise<void>;
  recheck: () => Promise<void>;
  loadProjects: () => Promise<void>;
  saveProject: (projectId: string, setting: PiProjectSandboxSetting) => Promise<boolean>;
  reset: () => void;
}

const initial = () => ({
  launchers: null,
  launchersStatus: 'idle' as const,
  rechecking: false,
  projects: {},
  projectsStatus: 'idle' as const,
  saving: {},
  saveErrors: {},
});

let generation = 0;

const errorText = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'INVALID_SANDBOX_SETTING') return 'The server refused this setting. Check the hosts, ports and folders.';
  if (code === 'PROJECT_NOT_FOUND') return 'This project no longer exists on the server.';
  return 'The sandbox setting could not be saved.';
};

export const useProjectSandboxStore = create<ProjectSandboxStoreState>()(
  devtools(
    (set) => ({
      ...initial(),

      loadLaunchers: async () => {
        const at = generation;
        set({ launchersStatus: 'loading' });
        try {
          const { launchers } = await piClient.getSandboxStatus();
          if (at !== generation) return;
          set({ launchers, launchersStatus: 'ready' });
        } catch {
          if (at !== generation) return;
          set({ launchersStatus: 'failed' });
        }
      },

      recheck: async () => {
        const at = generation;
        set({ rechecking: true });
        try {
          const { launchers } = await piClient.recheckSandbox();
          if (at !== generation) return;
          set({ launchers, launchersStatus: 'ready', rechecking: false });
        } catch {
          if (at !== generation) return;
          set({ launchersStatus: 'failed', rechecking: false });
          return;
        }
        // A launcher that became available changes every project's availability.
        try {
          const { projects } = await piClient.listProjectSandboxes();
          if (at !== generation) return;
          set({ projects: Object.fromEntries(projects.map((project) => [project.projectId, project])), projectsStatus: 'ready' });
        } catch {
          if (at !== generation) return;
          set({ projectsStatus: 'failed' });
        }
      },

      loadProjects: async () => {
        const at = generation;
        set({ projectsStatus: 'loading' });
        try {
          const { projects } = await piClient.listProjectSandboxes();
          if (at !== generation) return;
          set({ projects: Object.fromEntries(projects.map((project) => [project.projectId, project])), projectsStatus: 'ready' });
        } catch {
          if (at !== generation) return;
          set({ projectsStatus: 'failed' });
        }
      },

      saveProject: async (projectId, setting) => {
        const at = generation;
        set((state) => ({ saving: { ...state.saving, [projectId]: true } }));
        try {
          const project = await piClient.setProjectSandbox(projectId, setting);
          if (at !== generation) return false;
          set((state) => {
            const saving = { ...state.saving };
            delete saving[projectId];
            const saveErrors = { ...state.saveErrors };
            delete saveErrors[projectId];
            return { projects: { ...state.projects, [projectId]: project }, saving, saveErrors };
          });
          return true;
        } catch (error) {
          if (at !== generation) return false;
          set((state) => {
            const saving = { ...state.saving };
            delete saving[projectId];
            return { saving, saveErrors: { ...state.saveErrors, [projectId]: errorText(error) } };
          });
          return false;
        }
      },

      reset: () => {
        generation += 1;
        set(initial());
      },
    }),
    { name: 'project-sandbox-store' },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(() => {
    useProjectSandboxStore.getState().reset();
  });
}
