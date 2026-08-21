import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { Snippet } from '@/types/snippet';

export type SnippetScope = 'global' | 'project';

interface SnippetDraft {
  name: string;
  scope: SnippetScope;
  content?: string;
  description?: string;
}

interface SnippetsStore {
  snippets: Snippet[];
  isLoading: boolean;
  selectedSnippetName: string | null;
  snippetDraft: SnippetDraft | null;
  setSelectedSnippet: (name: string | null) => void;
  setSnippetDraft: (draft: SnippetDraft | null) => void;
  loadSnippets: () => Promise<boolean>;
  createSnippet: (name: string, content: string, options?: { description?: string; scope?: SnippetScope }) => Promise<boolean>;
  updateSnippet: (name: string, updates: { content?: string }) => Promise<boolean>;
  deleteSnippet: (name: string) => Promise<boolean>;
  /** Pi expands `/template` itself when the prompt is sent. */
  expandText: (text: string) => Promise<string>;
  getSnippetByName: (name: string) => Snippet | undefined;
}

const CACHE_TTL_MS = 5_000;
const loadedAtByKey = new Map<string, number>();
const inFlightByKey = new Map<string, Promise<boolean>>();

export const invalidateSnippetsLoadCache = (_directory?: string | null) => {
  void _directory;
  const key = getRuntimeKey();
  loadedAtByKey.delete(key);
  inFlightByKey.delete(key);
  if (!key || key === 'local') {
    loadedAtByKey.clear();
    inFlightByKey.clear();
  }
};

// legacy single-key aliases for tests that still reference the old globals
let loadedAt = 0;
let inFlight: Promise<boolean> | null = null;

const toSnippets = (resources: Awaited<ReturnType<typeof piClient.listResources>>): Snippet[] => resources.prompts.map((prompt) => ({
  name: prompt.name,
  content: prompt.content ?? '',
  aliases: [],
  ...(prompt.description ? { description: prompt.description } : {}),
  filePath: prompt.id,
  source: prompt.location === 'project' ? 'project' : 'global',
  editable: prompt.editable === true,
}));

export const useSnippetsStore = create<SnippetsStore>()(
  devtools((set, get) => ({
    snippets: [],
    isLoading: false,
    selectedSnippetName: null,
    snippetDraft: null,
    setSelectedSnippet: (name) => set({ selectedSnippetName: name }),
    setSnippetDraft: (draft) => set({ snippetDraft: draft }),
    loadSnippets: async () => {
      const runtimeKey = getRuntimeKey();
      const now = Date.now();
      const cachedAt = loadedAtByKey.get(runtimeKey) ?? loadedAt;
      if (cachedAt > 0 && now - cachedAt < CACHE_TTL_MS) return true;
      const existing = inFlightByKey.get(runtimeKey) ?? inFlight;
      if (existing) return existing;
      const request = (async () => {
        set({ isLoading: true });
        try {
          const resources = await piClient.listResources({ runtimeKey });
          const snippets = toSnippets(resources);
          set((state) => ({
            snippets,
            isLoading: false,
            ...(state.selectedSnippetName && !snippets.some((snippet) => snippet.name === state.selectedSnippetName)
              ? { selectedSnippetName: null }
              : {}),
          }));
          loadedAt = Date.now();
          loadedAtByKey.set(runtimeKey, Date.now());
          return true;
        } catch {
          set({ isLoading: false });
          return false;
        }
      })();
      inFlight = request;
      inFlightByKey.set(runtimeKey, request);
      try { return await request; } finally {
        inFlight = null;
        inFlightByKey.delete(runtimeKey);
      }
    },
    createSnippet: async (name, content, options = {}) => {
      const runtimeKey = getRuntimeKey();
      try {
        const resources = await piClient.createPromptTemplate({
          name,
          content,
          description: options.description ?? '',
          location: options.scope ?? 'global',
        }, { runtimeKey });
        set({ snippets: toSnippets(resources), snippetDraft: null, selectedSnippetName: name });
        loadedAt = Date.now();
        loadedAtByKey.set(runtimeKey, Date.now());
        return true;
      } catch {
        return false;
      }
    },
    updateSnippet: async (name, updates) => {
      const runtimeKey = getRuntimeKey();
      const snippet = get().snippets.find((item) => item.name === name);
      if (!snippet || updates.content === undefined) return false;
      try {
        const resources = await piClient.updateResource({ resourceId: snippet.filePath, content: updates.content }, { runtimeKey });
        set({ snippets: toSnippets(resources) });
        loadedAt = Date.now();
        loadedAtByKey.set(runtimeKey, Date.now());
        return true;
      } catch {
        return false;
      }
    },
    deleteSnippet: async (name) => {
      const runtimeKey = getRuntimeKey();
      const snippet = get().snippets.find((item) => item.name === name);
      if (!snippet) return false;
      try {
        const resources = await piClient.deletePromptTemplate(snippet.filePath, { runtimeKey });
        set({ snippets: toSnippets(resources), ...(get().selectedSnippetName === name ? { selectedSnippetName: null } : {}) });
        loadedAt = Date.now();
        loadedAtByKey.set(runtimeKey, Date.now());
        return true;
      } catch {
        return false;
      }
    },
    expandText: async (text) => text.replace(/(^|\s)#([a-z0-9_-]+)/gi, (match, prefix: string, name: string) => (
      get().snippets.some((snippet) => snippet.name.toLowerCase() === name.toLowerCase())
        ? `${prefix}/${name}`
        : match
    )),
    getSnippetByName: (name) => get().snippets.find((snippet) => snippet.name === name),
  }), { name: 'snippets-store' }),
);
