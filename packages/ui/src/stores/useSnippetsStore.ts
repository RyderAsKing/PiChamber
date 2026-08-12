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

let loadedAt = 0;
let inFlight: Promise<boolean> | null = null;
const CACHE_TTL_MS = 5_000;

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
      if (loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS) return true;
      if (inFlight) return inFlight;
      const request = (async () => {
        set({ isLoading: true });
        try {
          const resources = await piClient.listResources({ runtimeKey: getRuntimeKey() });
          const snippets = toSnippets(resources);
          set((state) => ({
            snippets,
            isLoading: false,
            ...(state.selectedSnippetName && !snippets.some((snippet) => snippet.name === state.selectedSnippetName)
              ? { selectedSnippetName: null }
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
      try { return await request; } finally { inFlight = null; }
    },
    createSnippet: async (name, content, options = {}) => {
      try {
        const resources = await piClient.createPromptTemplate({
          name,
          content,
          description: options.description ?? '',
          location: options.scope ?? 'global',
        }, { runtimeKey: getRuntimeKey() });
        set({ snippets: toSnippets(resources), snippetDraft: null, selectedSnippetName: name });
        loadedAt = Date.now();
        return true;
      } catch {
        return false;
      }
    },
    updateSnippet: async (name, updates) => {
      const snippet = get().snippets.find((item) => item.name === name);
      if (!snippet || updates.content === undefined) return false;
      try {
        const resources = await piClient.updateResource({ resourceId: snippet.filePath, content: updates.content }, { runtimeKey: getRuntimeKey() });
        set({ snippets: toSnippets(resources) });
        loadedAt = Date.now();
        return true;
      } catch {
        return false;
      }
    },
    deleteSnippet: async (name) => {
      const snippet = get().snippets.find((item) => item.name === name);
      if (!snippet) return false;
      try {
        const resources = await piClient.deletePromptTemplate(snippet.filePath, { runtimeKey: getRuntimeKey() });
        set({ snippets: toSnippets(resources), ...(get().selectedSnippetName === name ? { selectedSnippetName: null } : {}) });
        loadedAt = Date.now();
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
