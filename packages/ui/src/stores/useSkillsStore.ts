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
}

interface SkillsStore {
  selectedSkillName: string | null;
  skills: DiscoveredSkill[];
  isLoading: boolean;
  setSelectedSkill: (name: string | null) => void;
  loadSkills: () => Promise<boolean>;
  renameSkill: (name: string, newName: string) => Promise<boolean>;
  getSkillByName: (name: string) => DiscoveredSkill | undefined;
}

const CACHE_TTL_MS = 5_000;
let loadedAt = 0;
let inFlight: Promise<boolean> | null = null;

export const invalidateSkillsLoadCache = (_directory?: string | null) => {
  void _directory;
  loadedAt = 0;
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
          if (loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS) return true;
          if (inFlight) return inFlight;
          const request = (async () => {
            set({ isLoading: true });
            try {
              const response = await piClient.listResources({ runtimeKey: getRuntimeKey() });
              const skills = response.skills.map((skill) => ({
                id: skill.id,
                name: skill.name,
                path: skill.id,
                scope: (skill.location === 'project' ? 'project' : 'user') as SkillScope,
                source: 'agents' as const,
                ...(skill.description ? { description: skill.description } : {}),
                location: skill.location,
              }));
              set((state) => ({
                skills,
                isLoading: false,
                ...(state.selectedSkillName && !skills.some((skill) => skill.name === state.selectedSkillName)
                  ? { selectedSkillName: null }
                  : {}),
              }));
              loadedAt = Date.now();
              return true;
            } catch {
              set({ isLoading: false });
              return false;
            }
          })();
          inFlight = request;
          try {
            return await request;
          } finally {
            inFlight = null;
          }
        },
        // Pi package/source mutation is intentionally not exposed by WS5.
        renameSkill: async () => false,
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
