import { create } from "zustand";
import { devtools } from "zustand/middleware";

import { piClient } from "@/lib/pi/client";
import { getRuntimeKey } from "@/lib/runtime-switch";
import { invalidateCommandCatalogCache } from "@/lib/pi/commandCatalog";

export type PromptTemplateLocation = "global" | "project" | "package" | "path";

export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  content?: string;
  location: PromptTemplateLocation;
  editable: boolean;
}

export type PromptTemplateScopeFilter = "global" | "project";

interface PromptTemplateDraft {
  name: string;
  location: PromptTemplateScopeFilter;
  content?: string;
  description?: string;
}

interface PromptTemplatesStore {
  prompts: PromptTemplate[];
  isLoading: boolean;
  selectedPromptId: string | null;
  activeCacheKey: string;
  promptDraft: PromptTemplateDraft | null;
  setSelectedPrompt: (id: string | null) => void;
  setPromptDraft: (draft: PromptTemplateDraft | null) => void;
  resetForRuntimeSwitch: () => void;
  loadPrompts: (directory?: string) => Promise<boolean>;
  createPrompt: (
    name: string,
    content: string,
    options: {
      description: string;
      location: PromptTemplateScopeFilter;
      directory?: string;
    },
  ) => Promise<boolean>;
  updatePrompt: (
    id: string,
    updates: {
      name?: string;
      description?: string;
      content?: string;
      location?: PromptTemplateScopeFilter;
    },
    directory?: string,
  ) => Promise<boolean>;
  deletePrompt: (id: string, directory?: string) => Promise<boolean>;
  getPromptById: (id: string) => PromptTemplate | undefined;
}

const CACHE_TTL_MS = 5_000;
const loadedAtByKey = new Map<string, number>();
const inFlightByKey = new Map<string, Promise<boolean>>();
const promptsByKey = new Map<string, PromptTemplate[]>();
const revisionByKey = new Map<string, number>();

export const promptTemplatesCacheKey = (runtimeKey: string, directory?: string) =>
  `${runtimeKey}\n${directory?.trim() ?? ""}`;

const bumpRevision = (cacheKey: string): void => {
  revisionByKey.set(cacheKey, (revisionByKey.get(cacheKey) ?? 0) + 1);
  inFlightByKey.delete(cacheKey);
};

export const invalidatePromptTemplatesLoadCache = (
  directory?: string | null,
) => {
  const runtimeKey = getRuntimeKey();
  if (typeof directory === "string" && directory.trim().length > 0) {
    const cacheKey = promptTemplatesCacheKey(runtimeKey, directory);
    loadedAtByKey.delete(cacheKey);
    bumpRevision(cacheKey);
    return;
  }
  const keys = new Set([
    ...loadedAtByKey.keys(),
    ...inFlightByKey.keys(),
    ...promptsByKey.keys(),
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
    ...promptsByKey.keys(),
  ]);
  for (const cacheKey of keys) {
    if (!cacheKey.startsWith(`${runtimeKey}\n`)) continue;
    loadedAtByKey.delete(cacheKey);
    bumpRevision(cacheKey);
  }
};

const toPrompts = (
  response: Awaited<ReturnType<typeof piClient.listResources>>,
): PromptTemplate[] =>
  response.prompts.map((prompt) => ({
    id: prompt.id,
    name: prompt.name,
    ...(typeof prompt.description === "string"
      ? { description: prompt.description }
      : {}),
    ...(typeof prompt.content === "string" ? { content: prompt.content } : {}),
    location: (["global", "project", "package", "path"] as const).includes(
      prompt.location as PromptTemplateLocation,
    )
      ? (prompt.location as PromptTemplateLocation)
      : "path",
    editable: prompt.editable === true,
  }));

export const usePromptTemplatesStore = create<PromptTemplatesStore>()(
  devtools(
    (set, get) => ({
      prompts: [],
      isLoading: false,
      selectedPromptId: null,
      activeCacheKey: "",
      promptDraft: null,
      setSelectedPrompt: (id) => set({ selectedPromptId: id }),
      setPromptDraft: (draft) => set({ promptDraft: draft }),
      resetForRuntimeSwitch: () => {
        loadedAtByKey.clear();
        inFlightByKey.clear();
        promptsByKey.clear();
        revisionByKey.clear();
        set({
          prompts: [],
          isLoading: false,
          selectedPromptId: null,
          activeCacheKey: "",
          promptDraft: null,
        });
      },
      loadPrompts: async (directory?: string) => {
        const runtimeKey = getRuntimeKey();
        const normalizedDirectory =
          typeof directory === "string" && directory.trim().length > 0
            ? directory.trim()
            : undefined;
        const cacheKey = promptTemplatesCacheKey(runtimeKey, normalizedDirectory);
        const now = Date.now();
        const cached = promptsByKey.get(cacheKey);
        set({
          activeCacheKey: cacheKey,
          prompts: cached ?? [],
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
            const response = normalizedDirectory
              ? await piClient.listResources(normalizedDirectory, {
                  runtimeKey,
                })
              : await piClient.listResources({ runtimeKey });
            if (getRuntimeKey() !== runtimeKey) return false;
            if ((revisionByKey.get(cacheKey) ?? 0) !== requestRevision) {
              set((state) =>
                state.activeCacheKey === cacheKey ? { isLoading: false } : state,
              );
              return true;
            }
            const prompts = toPrompts(response);
            promptsByKey.set(cacheKey, prompts);
            loadedAtByKey.set(cacheKey, Date.now());
            set((state) =>
              state.activeCacheKey === cacheKey
                ? {
                    prompts,
                    isLoading: false,
                    ...(state.selectedPromptId &&
                    !prompts.some(
                      (prompt) => prompt.id === state.selectedPromptId,
                    )
                      ? { selectedPromptId: null }
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
      createPrompt: async (name, content, options) => {
        const runtimeKey = getRuntimeKey();
        const directory = options.directory?.trim()
          ? options.directory.trim()
          : undefined;
        try {
          const response = await piClient.createPromptTemplate(
            {
              name,
              description: options.description,
              content,
              location: options.location,
            },
            directory,
            { runtimeKey },
          );
          if (getRuntimeKey() !== runtimeKey) return false;
          const cacheKey = promptTemplatesCacheKey(runtimeKey, directory);
          const prompts = toPrompts(response);
          bumpRevision(cacheKey);
          promptsByKey.set(cacheKey, prompts);
          invalidateRuntimeTimestamps(runtimeKey);
          loadedAtByKey.set(cacheKey, Date.now());
          const created = prompts.find(
            (prompt) =>
              prompt.name === name &&
              prompt.location === options.location,
          );
          set((state) => state.activeCacheKey === cacheKey ? {
            prompts,
            promptDraft: null,
            selectedPromptId: created?.id ?? null,
            isLoading: false,
          } : state);
          // Global prompts affect every directory catalog; project prompts
          // affect only their owning effective directory.
          invalidateCommandCatalogCache(
            options.location === "global" ? null : directory,
          );
          return true;
        } catch {
          return false;
        }
      },
      updatePrompt: async (id, updates, directory?: string) => {
        const runtimeKey = getRuntimeKey();
        const prompt = get().prompts.find((item) => item.id === id);
        if (!prompt) return false;
        if (prompt.editable !== true) return false;
        const wantedDirectory =
          typeof directory === "string" && directory.trim().length > 0
            ? directory.trim()
            : undefined;
        if ((prompt.location === "project" || updates.location === "project") && !wantedDirectory) return false;
        try {
          const response = await piClient.updatePromptTemplate(
            prompt.id,
            {
              ...(updates.name !== undefined ? { name: updates.name } : {}),
              ...(updates.description !== undefined
                ? { description: updates.description }
                : {}),
              ...(updates.content !== undefined
                ? { content: updates.content }
                : {}),
              ...(updates.location !== undefined
                ? { location: updates.location }
                : {}),
            },
            wantedDirectory,
            { runtimeKey },
          );
          if (getRuntimeKey() !== runtimeKey) return false;
          const cacheKey = promptTemplatesCacheKey(runtimeKey, wantedDirectory);
          const prompts = toPrompts(response);
          bumpRevision(cacheKey);
          promptsByKey.set(cacheKey, prompts);
          invalidateRuntimeTimestamps(runtimeKey);
          loadedAtByKey.set(cacheKey, Date.now());
          const updated = prompts.find((item) =>
            item.name === (updates.name ?? prompt.name)
            && item.location === (updates.location ?? prompt.location));
          set((state) => state.activeCacheKey === cacheKey ? {
            prompts,
            selectedPromptId: updated?.id ?? null,
            isLoading: false,
          } : state);
          invalidateCommandCatalogCache(
            prompt.location === "global" || updates.location === "global"
              ? null
              : wantedDirectory,
          );
          return true;
        } catch {
          return false;
        }
      },
      deletePrompt: async (id, directory?: string) => {
        const runtimeKey = getRuntimeKey();
        const prompt = get().prompts.find((item) => item.id === id);
        if (!prompt) return false;
        if (prompt.editable !== true) return false;
        const wantedDirectory = directory?.trim()
          ? directory.trim()
          : undefined;
        if (prompt.location === "project" && !wantedDirectory) return false;
        try {
          const response = await piClient.deletePromptTemplate(
            prompt.id,
            wantedDirectory,
            { runtimeKey },
          );
          if (getRuntimeKey() !== runtimeKey) return false;
          const cacheKey = promptTemplatesCacheKey(runtimeKey, wantedDirectory);
          const prompts = toPrompts(response);
          bumpRevision(cacheKey);
          promptsByKey.set(cacheKey, prompts);
          invalidateRuntimeTimestamps(runtimeKey);
          loadedAtByKey.set(cacheKey, Date.now());
          set((state) => state.activeCacheKey === cacheKey ? {
            prompts,
            ...(state.selectedPromptId === id ? { selectedPromptId: null } : {}),
            isLoading: false,
          } : state);
          invalidateCommandCatalogCache(
            prompt.location === "global" ? null : wantedDirectory,
          );
          return true;
        } catch {
          return false;
        }
      },
      getPromptById: (id) =>
        get().prompts.find((prompt) => prompt.id === id),
    }),
    { name: "prompt-templates-store" },
  ),
);
