import { create } from "zustand";
import { devtools } from "zustand/middleware";

import { piClient } from "@/lib/pi/client";
import { getRuntimeKey } from "@/lib/runtime-switch";
import type { Snippet } from "@/types/snippet";

export type SnippetScope = "global" | "project";

interface SnippetDraft {
  name: string;
  scope: SnippetScope;
  content?: string;
  description?: string;
}

interface SnippetsStore {
  snippets: Snippet[];
  isLoading: boolean;
  selectedSnippetId: string | null;
  activeCacheKey: string;
  snippetDraft: SnippetDraft | null;
  setSelectedSnippet: (id: string | null) => void;
  setSnippetDraft: (draft: SnippetDraft | null) => void;
  resetForRuntimeSwitch: () => void;
  loadSnippets: (directory?: string) => Promise<boolean>;
  createSnippet: (
    name: string,
    content: string,
    options?: {
      description?: string;
      aliases?: string[];
      scope?: SnippetScope;
      directory?: string;
    },
  ) => Promise<boolean>;
  updateSnippet: (
    id: string,
    updates: {
      name?: string;
      content?: string;
      description?: string;
      aliases?: string[];
      scope?: SnippetScope;
      directory?: string;
    },
    directory?: string,
  ) => Promise<boolean>;
  deleteSnippet: (id: string, directory?: string) => Promise<boolean>;
  /** Replaces `#snippet` tokens with their content before sending. `#` is the only trigger for snippets. */
  expandText: (text: string, directory?: string) => string;
  getSnippetByName: (name: string) => Snippet | undefined;
}

const CACHE_TTL_MS = 5_000;
const loadedAtByKey = new Map<string, number>();
const inFlightByKey = new Map<string, Promise<boolean>>();
const snippetsByKey = new Map<string, Snippet[]>();
const revisionByKey = new Map<string, number>();

const cacheKeyFor = (runtimeKey: string, directory?: string) =>
  `${runtimeKey}\n${directory?.trim() ?? ""}`;

const bumpRevision = (cacheKey: string): void => {
  revisionByKey.set(cacheKey, (revisionByKey.get(cacheKey) ?? 0) + 1);
  inFlightByKey.delete(cacheKey);
};

export const invalidateSnippetsLoadCache = (directory?: string | null) => {
  const runtimeKey = getRuntimeKey();
  if (typeof directory === "string" && directory.trim().length > 0) {
    const cacheKey = cacheKeyFor(runtimeKey, directory);
    loadedAtByKey.delete(cacheKey);
    bumpRevision(cacheKey);
    return;
  }
  const keys = new Set([
    ...loadedAtByKey.keys(),
    ...inFlightByKey.keys(),
    ...snippetsByKey.keys(),
  ]);
  for (const cacheKey of keys) {
    if (!cacheKey.startsWith(`${runtimeKey}\n`)) continue;
    loadedAtByKey.delete(cacheKey);
    bumpRevision(cacheKey);
  }
};

const invalidateRuntimeTimestamps = (runtimeKey: string) => {
  const keys = new Set([
    ...loadedAtByKey.keys(),
    ...inFlightByKey.keys(),
    ...snippetsByKey.keys(),
  ]);
  for (const cacheKey of keys) {
    if (!cacheKey.startsWith(`${runtimeKey}\n`)) continue;
    loadedAtByKey.delete(cacheKey);
    bumpRevision(cacheKey);
  }
};

const toSnippets = (
  response: Awaited<ReturnType<typeof piClient.listSnippets>>,
): Snippet[] =>
  response.snippets.map((snippet) => ({
    id: snippet.id,
    name: snippet.name,
    content: snippet.content,
    aliases: snippet.aliases ?? [],
    ...(snippet.description ? { description: snippet.description } : {}),
    source: snippet.scope === "project" ? "project" : "global",
    ...(typeof snippet.directory === "string"
      ? { directory: snippet.directory }
      : {}),
  }));

export const useSnippetsStore = create<SnippetsStore>()(
  devtools(
    (set, get) => ({
      snippets: [],
      isLoading: false,
      selectedSnippetId: null,
      activeCacheKey: "",
      snippetDraft: null,
      setSelectedSnippet: (id) => set({ selectedSnippetId: id }),
      setSnippetDraft: (draft) => set({ snippetDraft: draft }),
      resetForRuntimeSwitch: () => {
        loadedAtByKey.clear();
        inFlightByKey.clear();
        snippetsByKey.clear();
        revisionByKey.clear();
        set({ snippets: [], isLoading: false, selectedSnippetId: null, activeCacheKey: "", snippetDraft: null });
      },
      loadSnippets: async (directory?: string) => {
        const runtimeKey = getRuntimeKey();
        const cacheKey = cacheKeyFor(runtimeKey, directory);
        const now = Date.now();
        const cached = snippetsByKey.get(cacheKey);
        set({
          activeCacheKey: cacheKey,
          snippets: cached ?? [],
          isLoading: true,
        });
        const cachedAt = loadedAtByKey.get(cacheKey) ?? 0;
        if (cachedAt > 0 && now - cachedAt < CACHE_TTL_MS) {
          set({ isLoading: false });
          return true;
        }
        const existing = inFlightByKey.get(cacheKey);
        if (existing) return existing;
        const requestRevision = revisionByKey.get(cacheKey) ?? 0;
        const request = (async () => {
          try {
            const response = await piClient.listSnippets(directory, {
              runtimeKey,
            });
            if (getRuntimeKey() !== runtimeKey) return false;
            if ((revisionByKey.get(cacheKey) ?? 0) !== requestRevision) {
              set((state) =>
                state.activeCacheKey === cacheKey ? { isLoading: false } : state,
              );
              return true;
            }
            const snippets = toSnippets(response);
            snippetsByKey.set(cacheKey, snippets);
            loadedAtByKey.set(cacheKey, Date.now());
            set((state) =>
              state.activeCacheKey === cacheKey
                ? {
                    snippets,
                    isLoading: false,
                    ...(state.selectedSnippetId &&
                    !snippets.some(
                      (snippet) => snippet.id === state.selectedSnippetId,
                    )
                      ? { selectedSnippetId: null }
                      : {}),
                  }
                : state,
            );
            return true;
          } catch {
            set((state) =>
              state.activeCacheKey === cacheKey ? { isLoading: false } : state,
            );
            return false;
          }
        })();
        inFlightByKey.set(cacheKey, request);
        try {
          return await request;
        } finally {
          if (inFlightByKey.get(cacheKey) === request) inFlightByKey.delete(cacheKey);
        }
      },
      createSnippet: async (name, content, options = {}) => {
        const runtimeKey = getRuntimeKey();
        const directory = options.directory?.trim()
          ? options.directory.trim()
          : undefined;
        try {
          const response = await piClient.createSnippet(
            {
              name,
              content,
              ...(options.description !== undefined
                ? { description: options.description }
                : {}),
              ...(options.aliases !== undefined
                ? { aliases: options.aliases }
                : {}),
              scope: options.scope ?? "global",
              ...(directory ? { directory } : {}),
            },
            { runtimeKey },
          );
          if (getRuntimeKey() !== runtimeKey) return false;
          const cacheKey = cacheKeyFor(runtimeKey, directory);
          const snippets = toSnippets(response);
          bumpRevision(cacheKey);
          snippetsByKey.set(cacheKey, snippets);
          invalidateRuntimeTimestamps(runtimeKey);
          loadedAtByKey.set(cacheKey, Date.now());
          const created = snippets.find(
            (snippet) =>
              snippet.name === name &&
              snippet.source === (options.scope ?? "global"),
          );
          set((state) => state.activeCacheKey === cacheKey ? {
            snippets,
            snippetDraft: null,
            selectedSnippetId: created?.id ?? null,
            isLoading: false,
          } : state);
          return true;
        } catch {
          return false;
        }
      },
      updateSnippet: async (id, updates, directory?: string) => {
        const runtimeKey = getRuntimeKey();
        const snippet = get().snippets.find((item) => item.id === id);
        if (!snippet) return false;
        const wantedDirectory = directory?.trim()
          ? directory.trim()
          : snippet.source === "project" && snippet.directory
            ? snippet.directory
            : undefined;
        try {
          const response = await piClient.updateSnippet(
            snippet.id,
            {
              ...(updates.name !== undefined ? { name: updates.name } : {}),
              ...(updates.content !== undefined
                ? { content: updates.content }
                : {}),
              ...(updates.description !== undefined
                ? { description: updates.description }
                : {}),
              ...(updates.aliases !== undefined
                ? { aliases: updates.aliases }
                : {}),
              ...(updates.scope !== undefined ? { scope: updates.scope } : {}),
              ...(updates.directory !== undefined
                ? { directory: updates.directory }
                : {}),
            },
            wantedDirectory,
            { runtimeKey },
          );
          if (getRuntimeKey() !== runtimeKey) return false;
          const cacheKey = cacheKeyFor(runtimeKey, wantedDirectory);
          const snippets = toSnippets(response);
          bumpRevision(cacheKey);
          snippetsByKey.set(cacheKey, snippets);
          invalidateRuntimeTimestamps(runtimeKey);
          loadedAtByKey.set(cacheKey, Date.now());
          set((state) => state.activeCacheKey === cacheKey ? { snippets, isLoading: false } : state);
          return true;
        } catch {
          return false;
        }
      },
      deleteSnippet: async (id, directory?: string) => {
        const runtimeKey = getRuntimeKey();
        const snippet = get().snippets.find((item) => item.id === id);
        if (!snippet) return false;
        const wantedDirectory = directory?.trim()
          ? directory.trim()
          : snippet.source === "project" && snippet.directory
            ? snippet.directory
            : undefined;
        try {
          const response = await piClient.deleteSnippet(
            snippet.id,
            wantedDirectory,
            { runtimeKey },
          );
          if (getRuntimeKey() !== runtimeKey) return false;
          const cacheKey = cacheKeyFor(runtimeKey, wantedDirectory);
          const snippets = toSnippets(response);
          bumpRevision(cacheKey);
          snippetsByKey.set(cacheKey, snippets);
          invalidateRuntimeTimestamps(runtimeKey);
          loadedAtByKey.set(cacheKey, Date.now());
          set((state) => state.activeCacheKey === cacheKey ? {
            snippets,
            isLoading: false,
            ...(state.selectedSnippetId === id ? { selectedSnippetId: null } : {}),
          } : state);
          return true;
        } catch {
          return false;
        }
      },
      expandText: (text, directory) => {
        if (!text || !text.includes("#")) return text;
        const cacheKey = cacheKeyFor(getRuntimeKey(), directory);
        const snippets =
          snippetsByKey.get(cacheKey) ??
          (get().activeCacheKey === cacheKey ? get().snippets : []);
        const contentByLower = new Map<string, string>();
        const ordered = [...snippets].sort(
          (a, b) =>
            Number(b.source === "project") - Number(a.source === "project"),
        );
        for (const snippet of ordered) {
          const lower = snippet.name.toLowerCase();
          if (!contentByLower.has(lower))
            contentByLower.set(lower, snippet.content);
          for (const alias of snippet.aliases ?? []) {
            const al = alias.toLowerCase();
            if (!contentByLower.has(al))
              contentByLower.set(al, snippet.content);
          }
        }
        if (contentByLower.size === 0) return text;
        return text.replace(
          /(^|\s)#([A-Za-z0-9][A-Za-z0-9_-]*)/g,
          (match, prefix: string, name: string) => {
            const content = contentByLower.get(name.toLowerCase());
            return content !== undefined ? `${prefix}${content}` : match;
          },
        );
      },
      getSnippetByName: (name) =>
        get().snippets.find((snippet) => snippet.name === name),
    }),
    { name: "snippets-store" },
  ),
);
