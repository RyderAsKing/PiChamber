import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { opencodeClient } from '@/lib/pi/legacy-ui-client';
import type { ProjectEntry } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { createProjectIdFromPath } from '@/lib/projectId';
import { getDeferredSafeStorage } from './utils/safeStorage';
import { useDirectoryStore } from './useDirectoryStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { PROJECT_COLORS } from '@/lib/projectMeta';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

/** Pick a color key that's least used among existing projects */
const pickAutoColor = (projects: ProjectEntry[]): string => {
  const colorKeys = PROJECT_COLORS.map((c) => c.key);
  const usageCounts = new Map<string, number>();
  for (const key of colorKeys) {
    usageCounts.set(key, 0);
  }
  for (const p of projects) {
    if (p.color && usageCounts.has(p.color)) {
      usageCounts.set(p.color, (usageCounts.get(p.color) ?? 0) + 1);
    }
  }
  // Find minimum usage, then pick randomly among those with min usage
  const minUsage = Math.min(...usageCounts.values());
  const candidates = colorKeys.filter((k) => usageCounts.get(k) === minUsage);
  return candidates[Math.floor(Math.random() * candidates.length)];
};

interface ProjectPathValidationResult {
  ok: boolean;
  normalizedPath?: string;
  reason?: string;
}

interface ProjectsStore {
  projects: ProjectEntry[];
  activeProjectId: string | null;
  manualProjectOrder: string[];

  addProject: (path: string, options?: { label?: string; id?: string }) => ProjectEntry | null;
  removeProject: (id: string) => void;
  setActiveProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  renameProject: (id: string, label: string) => void;
  updateProjectMeta: (id: string, meta: {
    label?: string;
    icon?: string | null;
    color?: string | null;
    iconBackground?: string | null;
    defaultModel?: string | null;
  }) => void;
  uploadProjectIcon: (id: string, file: File) => Promise<{ ok: boolean; error?: string }>;
  removeProjectIcon: (id: string) => Promise<{ ok: boolean; error?: string }>;
  discoverProjectIcon: (id: string, options?: { force?: boolean }) => Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  resetForRuntimeSwitch: () => void;
  validateProjectPath: (path: string) => ProjectPathValidationResult;
  synchronizeFromSettings: (settings: DesktopSettings) => void;
  getActiveProject: () => ProjectEntry | null;
}

const safeStorage = getDeferredSafeStorage();
const PROJECTS_STORAGE_KEY = 'projects';
const ACTIVE_PROJECT_STORAGE_KEY = 'activeProjectId';

const getLocalRuntimeOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const value = (window as typeof window & { __PICHAMBER_LOCAL_ORIGIN__?: string }).__PICHAMBER_LOCAL_ORIGIN__;
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
};

const getProjectsStorageNamespace = (): string => {
  const apiBaseUrl = getRuntimeApiBaseUrl().trim().replace(/\/+$/, '');
  if (!apiBaseUrl) return '';
  return apiBaseUrl;
};

const getProjectsStorageKey = (): string => {
  const namespace = getProjectsStorageNamespace();
  return namespace ? `${PROJECTS_STORAGE_KEY}:${encodeURIComponent(namespace)}` : PROJECTS_STORAGE_KEY;
};

const getActiveProjectStorageKey = (): string => {
  const namespace = getProjectsStorageNamespace();
  return namespace ? `${ACTIVE_PROJECT_STORAGE_KEY}:${encodeURIComponent(namespace)}` : ACTIVE_PROJECT_STORAGE_KEY;
};

const shouldReadLegacyProjectsCache = (): boolean => {
  const namespace = getProjectsStorageNamespace();
  if (!namespace) return true;
  const localOrigin = getLocalRuntimeOrigin();
  return Boolean(localOrigin && namespace === localOrigin);
};

const resolveTildePath = (value: string, homeDir?: string | null): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('~')) {
    return trimmed;
  }
  if (!homeDir) {
    return trimmed;
  }
  if (trimmed === '~') {
    return homeDir;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return `${homeDir}${trimmed.slice(1)}`;
  }
  return trimmed;
};

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const normalizeDefaultModel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return undefined;
  }
  return trimmed;
};

const normalizeIconBackground = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

const normalizeProjectPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const homeDirectory = safeStorage.getItem('homeDirectory') || useDirectoryStore.getState().homeDirectory || '';
  const expanded = resolveTildePath(trimmed, homeDirectory);

  const normalized = expanded.replace(/\\/g, '/');
  if (normalized === '/') {
    return '/';
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const deriveProjectLabel = (path: string): string => {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === '/') {
    return 'Root';
  }
  const segments = normalized.split('/').filter(Boolean);
  const raw = segments[segments.length - 1] || normalized;
  return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

const sanitizeProjectIconImage = (value: unknown): ProjectEntry['iconImage'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const mime = typeof candidate.mime === 'string' ? candidate.mime.trim() : '';
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? Math.max(0, Math.round(candidate.updatedAt))
    : 0;
  const source = candidate.source === 'custom' || candidate.source === 'auto'
    ? candidate.source
    : null;

  if (!mime || !updatedAt || !source) {
    return undefined;
  }

  return { mime, updatedAt, source };
};

const resolveUploadMime = (file: File): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null => {
  const rawType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (rawType === 'image/png' || rawType === 'image/jpeg' || rawType === 'image/svg+xml') {
    return rawType;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';

  return null;
};

const readFileAsDataUrl = async (file: File): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Failed to read icon file'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Failed to read icon file'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
};

const sanitizeProjects = (value: unknown): ProjectEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ProjectEntry[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!rawPath) continue;

    const normalizedPath = normalizeProjectPath(rawPath);
    if (!normalizedPath) continue;

    const id = createProjectIdFromPath(normalizedPath);
    if (!id) continue;

    if (seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project: ProjectEntry = {
      id,
      path: normalizedPath,
    };

    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      project.label = candidate.label.trim();
    }
    if (typeof candidate.icon === 'string' && candidate.icon.trim().length > 0) {
      project.icon = candidate.icon.trim();
    }
    if (candidate.iconImage === null) {
      project.iconImage = null;
    } else {
      const iconImage = sanitizeProjectIconImage(candidate.iconImage);
      if (iconImage) {
        project.iconImage = iconImage;
      }
    }
    if (typeof candidate.color === 'string' && candidate.color.trim().length > 0) {
      project.color = candidate.color.trim();
    }
    const defaultModel = normalizeDefaultModel(candidate.defaultModel);
    if (defaultModel) {
      project.defaultModel = defaultModel;
    }
    if (candidate.iconBackground === null) {
      project.iconBackground = null;
    } else {
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      if (iconBackground) {
        project.iconBackground = iconBackground;
      }
    }
    if (typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt) && candidate.addedAt >= 0) {
      project.addedAt = candidate.addedAt;
    }
    if (typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt) && candidate.lastOpenedAt >= 0) {
      project.lastOpenedAt = candidate.lastOpenedAt;
    }
    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }
    result.push(project);
  }

  return result;
};

const readPersistedProjects = (): ProjectEntry[] => {
  try {
    const raw = safeStorage.getItem(getProjectsStorageKey())
      || (shouldReadLegacyProjectsCache() ? safeStorage.getItem(PROJECTS_STORAGE_KEY) : null);
    if (!raw) {
      return [];
    }
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return [];
  }
};

const readPersistedManualOrder = (): string[] => {
  try {
    const raw = safeStorage.getItem(getProjectsStorageKey() + ':manualOrder');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const readPersistedActiveProjectId = (): string | null => {
  try {
    const raw = safeStorage.getItem(getActiveProjectStorageKey())
      || (shouldReadLegacyProjectsCache() ? safeStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) : null);
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    return null;
  }
  return null;
};

const cacheProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  try {
    safeStorage.setItem(getProjectsStorageKey(), JSON.stringify(projects));
  } catch {
    // ignored
  }

  try {
    const activeProjectStorageKey = getActiveProjectStorageKey();
    if (activeProjectId) {
      safeStorage.setItem(activeProjectStorageKey, activeProjectId);
    } else {
      safeStorage.removeItem(activeProjectStorageKey);
    }
  } catch {
    // ignored
  }
};

const persistProjects = (projects: ProjectEntry[], activeProjectId: string | null, manualOrder?: string[]) => {
  cacheProjects(projects, activeProjectId);
  if (manualOrder) {
    persistManualProjectOrder(manualOrder);
  }
  void updateDesktopSettings({ projects, activeProjectId: activeProjectId ?? undefined });
};

const persistManualProjectOrder = (manualOrder: string[]) => {
  try {
    safeStorage.setItem(getProjectsStorageKey() + ':manualOrder', JSON.stringify(manualOrder));
  } catch {
    // ignored
  }
};

const initialProjects = readPersistedProjects();

const initialActiveProjectId = initialProjects.some((project) => project.id === readPersistedActiveProjectId())
  ? readPersistedActiveProjectId()
  : initialProjects[0]?.id ?? null;

export const useProjectsStore = create<ProjectsStore>()(
  devtools((set, get) => ({
    projects: initialProjects,
    activeProjectId: initialActiveProjectId,
    manualProjectOrder: readPersistedManualOrder(),

    validateProjectPath: (path: string): ProjectPathValidationResult => {
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { ok: false, reason: 'Provide a directory path.' };
      }

      const normalized = normalizeProjectPath(path);
      if (!normalized) {
        return { ok: false, reason: 'Directory path cannot be empty.' };
      }

      return { ok: true, normalizedPath: normalized };
    },

    addProject: (path: string, options?: { label?: string; id?: string }) => {
      const { validateProjectPath } = get();
      const validation = validateProjectPath(path);
      if (!validation.ok || !validation.normalizedPath) {
        return null;
      }

      const normalizedPath = validation.normalizedPath;
      const existing = get().projects.find((project) => project.path === normalizedPath);
      if (existing) {
        get().setActiveProject(existing.id);
        return existing;
      }

      const now = Date.now();
      const label = options?.label?.trim() || deriveProjectLabel(normalizedPath);
      const id = createProjectIdFromPath(normalizedPath);
      const entry: ProjectEntry = {
        id,
        path: normalizedPath,
        label,
        color: pickAutoColor(get().projects),
        addedAt: now,
        lastOpenedAt: now,
      };

      const nextProjects = [...get().projects, entry];
      set({ projects: nextProjects });

      if (streamDebugEnabled()) {
        console.info('[ProjectsStore] Added project', entry);
      }

      get().setActiveProject(entry.id);
      return entry;
    },

    removeProject: (id: string) => {
      const current = get();
      const nextProjects = current.projects.filter((project) => project.id !== id);
      let nextActiveId = current.activeProjectId;

      if (current.activeProjectId === id) {
        nextActiveId = nextProjects[0]?.id ?? null;
      }

      const nextManualOrder = get().manualProjectOrder.filter((oid) => oid !== id);
      set({ projects: nextProjects, activeProjectId: nextActiveId, manualProjectOrder: nextManualOrder });
      persistProjects(nextProjects, nextActiveId, nextManualOrder);

      if (nextActiveId) {
        const nextActive = nextProjects.find((project) => project.id === nextActiveId);
        if (nextActive) {
          opencodeClient.setDirectory(nextActive.path);
          useDirectoryStore.getState().setDirectory(nextActive.path, { showOverlay: false });
        }
      } else {
        void useDirectoryStore.getState().goHome();
      }
    },

    setActiveProject: (id: string) => {
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      set({ projects: nextProjects, activeProjectId: id });
      persistProjects(nextProjects, id, get().manualProjectOrder);

      opencodeClient.setDirectory(target.path);
      useDirectoryStore.getState().setDirectory(target.path, { showOverlay: false });
    },

    setActiveProjectIdOnly: (id: string) => {
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      set({ projects: nextProjects, activeProjectId: id });
      persistProjects(nextProjects, id, get().manualProjectOrder);
    },

    renameProject: (id: string, label: string) => {
      const trimmed = label.trim();
      if (!trimmed) {
        return;
      }

      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, label: trimmed } : project
      );
      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
    },

    updateProjectMeta: (id: string, meta: {
      label?: string;
      icon?: string | null;
      color?: string | null;
      iconBackground?: string | null;
      defaultModel?: string | null;
    }) => {
      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) => {
        if (project.id !== id) return project;
        const updated = { ...project };
        if (meta.label !== undefined) {
          const trimmed = meta.label.trim();
          if (trimmed) updated.label = trimmed;
        }
        if (meta.icon !== undefined) updated.icon = meta.icon;
        if (meta.color !== undefined) updated.color = meta.color;
        if (meta.iconBackground !== undefined) {
          updated.iconBackground = normalizeIconBackground(meta.iconBackground);
        }
        if (meta.defaultModel !== undefined) {
          const normalized = normalizeDefaultModel(meta.defaultModel);
          if (normalized) {
            updated.defaultModel = normalized;
          } else {
            delete updated.defaultModel;
          }
        }
        return updated;
      });
      set({ projects: nextProjects });
      persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
    },

    uploadProjectIcon: async (id: string, file: File) => {

      const mime = resolveUploadMime(file);
      if (!mime) {
        return { ok: false, error: 'Only PNG, JPEG, and SVG are supported' };
      }
      if (!Number.isFinite(file.size) || file.size <= 0) {
        return { ok: false, error: 'Icon file is empty' };
      }
      if (file.size > 5 * 1024 * 1024) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const normalizedDataUrl = dataUrl.replace(/^data:[^;]+;/i, `data:${mime};`);

        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ dataUrl: normalizedDataUrl }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to upload project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to upload project icon' };
      }
    },

    removeProjectIcon: async (id: string) => {

      try {
        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to remove project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to remove project icon' };
      }
    },

    discoverProjectIcon: async () => {
      // Automatic project-icon discovery belonged to the removed PiChamber
      // configuration backend. Keep the caller contract as an intentional
      // unsupported no-op rather than probing a route that does not exist.
      return { ok: true, skipped: true, reason: 'unsupported' };
    },

    reorderProjects: (fromIndex: number, toIndex: number) => {
      const { projects, activeProjectId } = get();
      if (
        fromIndex < 0 ||
        fromIndex >= projects.length ||
        toIndex < 0 ||
        toIndex >= projects.length ||
        fromIndex === toIndex
      ) {
        return;
      }

      const nextProjects = [...projects];
      const [moved] = nextProjects.splice(fromIndex, 1);
      nextProjects.splice(toIndex, 0, moved);

      const newOrder = nextProjects.map((p) => p.id);
      set({ projects: nextProjects, manualProjectOrder: newOrder });
      persistProjects(nextProjects, activeProjectId, newOrder);
    },

    resetForRuntimeSwitch: () => {
      const projects = readPersistedProjects();
      const activeProjectId = readPersistedActiveProjectId();
      const nextActiveProjectId = projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : projects[0]?.id ?? null;
      set({ projects, activeProjectId: nextActiveProjectId, manualProjectOrder: [] });
    },

    synchronizeFromSettings: (settings: DesktopSettings) => {
      const incomingProjects = sanitizeProjects(settings.projects ?? []);
      const incomingActive = typeof settings.activeProjectId === 'string' && settings.activeProjectId.trim()
        ? settings.activeProjectId.trim()
        : null;

      const current = get();

      const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(incomingProjects);
      const activeChanged = current.activeProjectId !== incomingActive;

      if (!projectsChanged && !activeChanged) {
        return;
      }

      const incomingIds = new Set(incomingProjects.map((p) => p.id));
      const cleanedOrder = get().manualProjectOrder.filter((id) => incomingIds.has(id));
      set({ projects: incomingProjects, activeProjectId: incomingActive, manualProjectOrder: cleanedOrder });
      cacheProjects(incomingProjects, incomingActive);
      persistManualProjectOrder(cleanedOrder);

      if (incomingActive) {
        const activeProject = incomingProjects.find((project) => project.id === incomingActive);
        if (activeProject) {
          opencodeClient.setDirectory(activeProject.path);
          useDirectoryStore.getState().setDirectory(activeProject.path, { showOverlay: false });
        }
      }
    },

    getActiveProject: () => {
      const { projects, activeProjectId } = get();
      if (!activeProjectId) {
        return null;
      }
      return projects.find((project) => project.id === activeProjectId) ?? null;
    },

  }), { name: 'projects-store' })
);

if (typeof window !== 'undefined') {
  window.addEventListener('pichamber:settings-synced', (event: Event) => {
    const detail = (event as CustomEvent<DesktopSettings>).detail;
    if (detail && typeof detail === 'object') {
      useProjectsStore.getState().synchronizeFromSettings(detail);
    }
  });
}
