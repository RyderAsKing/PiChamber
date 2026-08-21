import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

export type SkillScope = 'user' | 'project';
export type SkillSource = 'agents';

/** A Pi-discovered skill. `path` is an opaque daemon id, never a filesystem path. */
export interface DiscoveredSkill {
  id: string;
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
  location: 'global' | 'project' | 'package' | 'path';
  /** Markdown body of the SKILL.md file, when the daemon returns it. */
  content?: string;
  editable?: boolean;
}

interface SkillsStore {
  selectedSkillName: string | null;
  skills: DiscoveredSkill[];
  isLoading: boolean;
  setSelectedSkill: (name: string | null) => void;
  loadSkills: () => Promise<boolean>;
  renameSkill: (name: string, newName: string) => Promise<boolean>;
  updateSkillContent: (name: string, content: string) => Promise<boolean>;
  getSkillByName: (name: string) => DiscoveredSkill | undefined;
}

const CACHE_TTL_MS = 5_000;
const loadedAtByKey = new Map<string, number>();
const inFlightByKey = new Map<string, Promise<boolean>>();

export const invalidateSkillsLoadCache = (_directory?: string | null) => {
  void _directory;
  const key = getRuntimeKey();
  loadedAtByKey.delete(key);
  inFlightByKey.delete(key);
  // Tests and callers that invalidate without a runtime context still need a global reset.
  if (!key || key === 'local') {
    loadedAtByKey.clear();
    inFlightByKey.clear();
  }
};

export const useSkillsStore = create<SkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        selectedSkillName: null,
        skills: [],
        isLoading: false,
        setSelectedSkill: (name) => set({ selectedSkillName: name }),
        loadSkills: async () => {
          const runtimeKey = getRuntimeKey();
          const now = Date.now();
          const cachedAt = loadedAtByKey.get(runtimeKey) ?? 0;
          if (cachedAt > 0 && now - cachedAt < CACHE_TTL_MS) return true;
          const existing = inFlightByKey.get(runtimeKey);
          if (existing) return existing;
          const request = (async () => {
            set({ isLoading: true });
            try {
              const response = await piClient.listResources({ runtimeKey });
              const skills = response.skills.map((skill) => ({
                id: skill.id,
                name: skill.name,
                path: skill.id,
                scope: (skill.location === 'project' ? 'project' : 'user') as SkillScope,
                source: 'agents' as const,
                ...(skill.description ? { description: skill.description } : {}),
                location: skill.location,
                ...(typeof skill.content === 'string' && skill.content.length > 0 ? { content: skill.content } : {}),
                ...(skill.editable === true ? { editable: true as const } : {}),
              }));
              set((state) => ({
                skills,
                isLoading: false,
                ...(state.selectedSkillName && !skills.some((skill) => skill.name === state.selectedSkillName)
                  ? { selectedSkillName: null }
                  : {}),
              }));
              loadedAtByKey.set(runtimeKey, Date.now());
              return true;
            } catch {
              set({ isLoading: false });
              return false;
            }
          })();
          inFlightByKey.set(runtimeKey, request);
          try {
            return await request;
          } finally {
            inFlightByKey.delete(runtimeKey);
          }
        },
        // Pi package/source mutation is intentionally not exposed by WS5.
        renameSkill: async () => false,
        updateSkillContent: async (name, content) => {
          const skill = get().skills.find((item) => item.name === name);
          if (!skill) return false;
          try {
            const response = await piClient.updateResource({ resourceId: skill.id, content }, { runtimeKey: getRuntimeKey() });
            const nextSkills = response.skills.map((item) => ({
              id: item.id,
              name: item.name,
              path: item.id,
              scope: (item.location === 'project' ? 'project' : 'user') as SkillScope,
              source: 'agents' as const,
              ...(item.description ? { description: item.description } : {}),
              location: item.location,
              ...(typeof item.content === 'string' && item.content.length > 0 ? { content: item.content } : {}),
              ...(item.editable === true ? { editable: true as const } : {}),
            }));
            set({ skills: nextSkills });
            loadedAtByKey.set(getRuntimeKey(), Date.now());
            return true;
          } catch {
            return false;
          }
        },
        getSkillByName: (name) => get().skills.find((skill) => skill.name === name),
      }),
      {
        name: 'skills-store',
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({ selectedSkillName: state.selectedSkillName }),
      },
    ),
    { name: 'skills-store' },
  ),
);
