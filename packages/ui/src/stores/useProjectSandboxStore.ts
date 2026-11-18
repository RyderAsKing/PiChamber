import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { piClient } from '@/lib/pi/client';
import type {
  PiProjectSandboxSetting,
  PiProjectSandboxState,
  PiSandboxDefaults,
  PiSandboxDefaultsUpdate,
  PiSandboxLauncherStatus,
  PiSandboxProfile,
} from '@/lib/pi/protocol';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { settingUpdate } from '@/components/sections/projects/projectSandboxDraft';

/**
 * Project sandboxes (#242) as the server reports them: launcher status and
 * each project's sandbox setting. The server is authoritative; this store
 * only caches its last answer for Settings and the terminal note.
 *
 * `status` separates "never loaded" and "failed" from a loaded empty list,
 * so a failed fetch never reads as "no project is sandboxed". A runtime
 * switch drops everything, and answers that arrive after one are ignored.
 * A reload keeps the previous data on screen, and a failed reload keeps it
 * too (`status` says `failed`). A save the server may have stored before it
 * failed reloads, so the store shows what the server really holds.
 */
type ProjectSandboxLoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

interface ProjectSandboxStoreState {
  launchers: PiSandboxLauncherStatus[] | null;
  launchersStatus: ProjectSandboxLoadStatus;
  rechecking: boolean;
  projects: Record<string, PiProjectSandboxState>;
  projectsStatus: ProjectSandboxLoadStatus;
  defaults: PiSandboxDefaults | null;
  defaultsStatus: ProjectSandboxLoadStatus;
  savingDefaults: boolean;
  defaultsError: string | null;
  /** The launcher profile in use; null with `ready` when the server has none. */
  profile: PiSandboxProfile | null;
  profileStatus: ProjectSandboxLoadStatus;
  savingProfile: boolean;
  /** Why the last profile save or reset failed, cleared by the next one. */
  profileErrors: string[];
  /** Projects with a save in flight. */
  saving: Record<string, true>;
  /** Last save error per project, cleared by the next successful save. */
  saveErrors: Record<string, string>;
  loadLaunchers: () => Promise<void>;
  recheck: () => Promise<void>;
  loadProjects: () => Promise<void>;
  saveProject: (projectId: string, setting: PiProjectSandboxSetting) => Promise<boolean>;
  loadDefaults: () => Promise<void>;
  saveDefaults: (defaults: PiSandboxDefaultsUpdate) => Promise<boolean>;
  loadProfile: () => Promise<void>;
  /** Save `content` as the custom profile. */
  saveProfile: (content: string) => Promise<boolean>;
  /** Remove the custom profile. */
  resetProfile: () => Promise<boolean>;
  reset: () => void;
}

const initial = () => ({
  launchers: null,
  launchersStatus: 'idle' as const,
  rechecking: false,
  projects: {},
  projectsStatus: 'idle' as const,
  defaults: null,
  defaultsStatus: 'idle' as const,
  savingDefaults: false,
  defaultsError: null,
  profile: null,
  profileStatus: 'idle' as const,
  savingProfile: false,
  profileErrors: [],
  saving: {},
  saveErrors: {},
});

let generation = 0;
// Bumped when a save starts and again when it ends, whether or not the
// server answered. A project list or default requested before either is
// older than the save and is loaded again instead of committed. A save that
// finds another save started or ended while it was out cannot tell which
// the server took last, so it loads the list again instead of trusting its
// own answer for the parts both touch.
let saveRevision = 0;
// The newest request of each kind. An answer to an older one is dropped: it
// may have been read before the newer one and arrive after it.
let projectsRequest = 0;
let defaultsRequest = 0;
let profileRequest = 0;

/** Requests are held to the runtime they started on; a retry after a
 *  runtime switch must not reach the other server. */
const runtimeScope = (): { runtimeKey: string } | undefined => {
  const runtimeKey = getRuntimeKey();
  return runtimeKey ? { runtimeKey } : undefined;
};

/** Refused by validation or an unknown project: nothing was stored. */
const savedNothing = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'INVALID_SANDBOX_SETTING' || code === 'PROJECT_NOT_FOUND';
};

const errorText = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'INVALID_SANDBOX_SETTING') {
    const reason = (error as { reason?: unknown }).reason;
    if (reason === 'HOSTS') return 'The server refused an allowed host. Use host names such as api.example.com, without a scheme, path or port.';
    if (reason === 'PORTS') return 'The server refused a local port. Use port numbers from 1 to 65535.';
    if (reason === 'REFUSED_PORT') return 'Ports 80 and 443 cannot be local ports, because they would reach any host. Add the host instead.';
    if (reason === 'FOLDERS') return 'The server refused an extra folder. Use full paths on the server machine.';
    return 'The server refused this setting. Check the hosts, ports and folders.';
  }
  if (code === 'PROJECT_NOT_FOUND') return 'This project no longer exists on the server.';
  return 'The sandbox setting could not be saved.';
};

const profileErrorText = (error: unknown): string[] => {
  const { code, messages } = (error ?? {}) as { code?: unknown; messages?: unknown };
  if (code !== 'INVALID_SANDBOX_PROFILE') return ['The sandbox profile could not be saved.'];
  const list = Array.isArray(messages) ? messages.filter((entry): entry is string => typeof entry === 'string') : [];
  return list.length > 0 ? list : ['nono does not accept this profile.'];
};

export const useProjectSandboxStore = create<ProjectSandboxStoreState>()(
  devtools(
    (set, get) => {
      // A profile save or reset. Any load still out is older than it, so its
      // answer is dropped. A refusal stored nothing; any other failure may
      // have, so the profile is loaded again. Projects are loaded again
      // either way: a profile change clears failed starts.
      const changeProfile = async (send: () => Promise<PiSandboxProfile | null>): Promise<boolean> => {
        const at = generation;
        profileRequest += 1;
        set({ savingProfile: true });
        try {
          const profile = await send();
          if (at !== generation) return false;
          profileRequest += 1;
          set({ profile, profileStatus: 'ready', savingProfile: false, profileErrors: [] });
          void get().loadProjects();
          return true;
        } catch (error) {
          if (at !== generation) return false;
          set({ savingProfile: false, profileErrors: profileErrorText(error) });
          if ((error as { code?: unknown } | null)?.code !== 'INVALID_SANDBOX_PROFILE') await get().loadProfile();
          return false;
        }
      };
      return {
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
        await get().loadProjects();
      },

      loadProjects: async () => {
        const at = generation;
        const revision = saveRevision;
        projectsRequest += 1;
        const request = projectsRequest;
        set({ projectsStatus: 'loading' });
        try {
          const { projects } = await piClient.listProjectSandboxes(runtimeScope());
          if (at !== generation || request !== projectsRequest) return;
          if (revision !== saveRevision) return get().loadProjects();
          set({ projects: Object.fromEntries(projects.map((project) => [project.projectId, project])), projectsStatus: 'ready' });
        } catch {
          if (at !== generation || request !== projectsRequest) return;
          set({ projectsStatus: 'failed' });
        }
      },

      saveProject: async (projectId, setting) => {
        // Only what changed against the copy this device holds; the server
        // keeps the rest.
        const update = settingUpdate(setting, get().projects[projectId]);
        if (Object.keys(update).length === 0) return true;
        const at = generation;
        saveRevision += 1;
        const started = saveRevision;
        set((state) => ({ saving: { ...state.saving, [projectId]: true } }));
        try {
          const project = await piClient.setProjectSandbox(projectId, update, runtimeScope());
          if (at !== generation) return false;
          const overlapped = saveRevision !== started;
          saveRevision += 1;
          set((state) => {
            const saving = { ...state.saving };
            delete saving[projectId];
            const saveErrors = { ...state.saveErrors };
            delete saveErrors[projectId];
            return { projects: { ...state.projects, [projectId]: project }, saving, saveErrors };
          });
          // Another save crossed this one (the default decides this
          // project's mode): the server's list settles it.
          if (overlapped) await get().loadProjects();
          return true;
        } catch (error) {
          if (at !== generation) return false;
          saveRevision += 1;
          set((state) => {
            const saving = { ...state.saving };
            delete saving[projectId];
            return { saving, saveErrors: { ...state.saveErrors, [projectId]: errorText(error) } };
          });
          if (!savedNothing(error)) await Promise.all([get().loadProjects(), get().loadDefaults()]);
          return false;
        }
      },

      loadDefaults: async () => {
        const at = generation;
        const revision = saveRevision;
        defaultsRequest += 1;
        const request = defaultsRequest;
        set({ defaultsStatus: 'loading' });
        try {
          const defaults = await piClient.getSandboxDefaults(runtimeScope());
          if (at !== generation || request !== defaultsRequest) return;
          if (revision !== saveRevision) return get().loadDefaults();
          set({ defaults, defaultsStatus: 'ready' });
        } catch {
          if (at !== generation || request !== defaultsRequest) return;
          set({ defaultsStatus: 'failed' });
        }
      },

      // Every project that follows the default changes with it, so the
      // answer replaces the whole project list.
      saveDefaults: async (next) => {
        const at = generation;
        saveRevision += 1;
        const started = saveRevision;
        set({ savingDefaults: true });
        try {
          const { defaults, projects } = await piClient.setSandboxDefaults(next, runtimeScope());
          if (at !== generation) return false;
          const overlapped = saveRevision !== started;
          saveRevision += 1;
          if (overlapped) {
            // The list in this answer may be from before another save the
            // server has since taken; it is not committed.
            set({ savingDefaults: false, defaultsError: null });
            await Promise.all([get().loadProjects(), get().loadDefaults()]);
            return true;
          }
          set({
            defaults,
            defaultsStatus: 'ready',
            savingDefaults: false,
            defaultsError: null,
            projects: Object.fromEntries(projects.map((project) => [project.projectId, project])),
            projectsStatus: 'ready',
          });
          return true;
        } catch (error) {
          if (at !== generation) return false;
          saveRevision += 1;
          const code = (error as { code?: unknown } | null)?.code;
          set({
            savingDefaults: false,
            defaultsError: code === 'INVALID_SANDBOX_SETTING'
              ? ((error as { reason?: unknown }).reason === 'MODE'
                ? 'The saved default could not be read. Choose whether projects are sandboxed by default first.'
                : 'The server refused this setting. Check the hosts.')
              : 'The sandbox default could not be saved.',
          });
          if (!savedNothing(error)) await Promise.all([get().loadProjects(), get().loadDefaults()]);
          return false;
        }
      },

      loadProfile: async () => {
        const at = generation;
        profileRequest += 1;
        const request = profileRequest;
        set({ profileStatus: 'loading' });
        try {
          const profile = await piClient.getSandboxProfile(runtimeScope());
          if (at !== generation || request !== profileRequest) return;
          set({ profile, profileStatus: 'ready' });
        } catch {
          if (at !== generation || request !== profileRequest) return;
          set({ profileStatus: 'failed' });
        }
      },

      saveProfile: (content) => changeProfile(() => piClient.saveSandboxProfile(content, runtimeScope())),

      resetProfile: () => changeProfile(() => piClient.resetSandboxProfile(runtimeScope())),

      reset: () => {
        generation += 1;
        set(initial());
      },
      };
    },
    { name: 'project-sandbox-store' },
  ),
);

if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged(() => {
    useProjectSandboxStore.getState().reset();
  });
}
