import { beforeEach, describe, expect, mock, test } from "bun:test";

let resourcesImpl: (directory?: string) => Promise<{
  skills: never[];
  prompts: Array<{
    id: string;
    kind: string;
    name: string;
    description?: string;
    content?: string;
    location: string;
    editable?: boolean;
  }>;
  agents: never[];
}>;
let createImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  skills: [],
  prompts: [],
  agents: [],
});
let updateImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  skills: [],
  prompts: [],
  agents: [],
});
let deleteImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  skills: [],
  prompts: [],
  agents: [],
});
let runtimeKey = "runtime-1";

mock.module("@/lib/pi/client", () => ({
  piClient: {
    listResources: (dirOrScope?: unknown) => {
      const dir = typeof dirOrScope === "string" ? dirOrScope : undefined;
      return resourcesImpl(dir);
    },
    createPromptTemplate: (...args: unknown[]) => createImpl(...args),
    updatePromptTemplate: (...args: unknown[]) => updateImpl(...args),
    deletePromptTemplate: (...args: unknown[]) => deleteImpl(...args),
  },
}));
mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => runtimeKey,
}));

const { invalidatePromptTemplatesLoadCache, usePromptTemplatesStore } =
  await import("./usePromptTemplatesStore");

describe("usePromptTemplatesStore", () => {
  beforeEach(() => {
    runtimeKey = "runtime-1";
    createImpl = async () => ({ skills: [], prompts: [], agents: [] });
    updateImpl = async () => ({ skills: [], prompts: [], agents: [] });
    deleteImpl = async () => ({ skills: [], prompts: [], agents: [] });
    resourcesImpl = async () => ({ skills: [], prompts: [], agents: [] });
    invalidatePromptTemplatesLoadCache();
    usePromptTemplatesStore.setState({
      prompts: [],
      isLoading: false,
      selectedPromptId: null,
      activeCacheKey: "",
      promptDraft: null,
    });
  });

  test("lists global and project prompts with editable flags", async () => {
    resourcesImpl = async () => ({
      skills: [],
      prompts: [
        { id: "p1", kind: "prompt", name: "review", description: "Review", location: "global", editable: true, content: "Do $1" },
        { id: "p2", kind: "prompt", name: "pkg", location: "package", editable: false },
      ],
      agents: [],
    });
    expect(await usePromptTemplatesStore.getState().loadPrompts("/work")).toBe(true);
    const prompts = usePromptTemplatesStore.getState().prompts;
    expect(prompts).toHaveLength(2);
    expect(prompts.find((p) => p.id === "p1")?.editable).toBe(true);
    expect(prompts.find((p) => p.id === "p2")?.editable).toBe(false);
  });

  test("failed fetch preserves prior same-directory state", async () => {
    resourcesImpl = async () => ({
      skills: [],
      prompts: [{ id: "p1", kind: "prompt", name: "review", location: "global", editable: true }],
      agents: [],
    });
    await usePromptTemplatesStore.getState().loadPrompts("/work");
    resourcesImpl = async () => {
      throw new Error("unavailable");
    };
    invalidatePromptTemplatesLoadCache("/work");
    expect(await usePromptTemplatesStore.getState().loadPrompts("/work")).toBe(false);
    expect(usePromptTemplatesStore.getState().prompts).toHaveLength(1);
  });

  test("slow directory A cannot replace directory B", async () => {
    let resolveA!: (v: Awaited<ReturnType<typeof resourcesImpl>>) => void;
    let resolveB!: (v: Awaited<ReturnType<typeof resourcesImpl>>) => void;
    resourcesImpl = (dir) =>
      new Promise((resolve) => {
        if (dir === "/a") resolveA = resolve;
        else resolveB = resolve;
      });
    invalidatePromptTemplatesLoadCache("/a");
    invalidatePromptTemplatesLoadCache("/b");
    const loadA = usePromptTemplatesStore.getState().loadPrompts("/a");
    const loadB = usePromptTemplatesStore.getState().loadPrompts("/b");
    resolveB({ skills: [], prompts: [{ id: "b", kind: "prompt", name: "b", location: "global", editable: true }], agents: [] });
    await loadB;
    resolveA({ skills: [], prompts: [{ id: "a", kind: "prompt", name: "a", location: "global", editable: true }], agents: [] });
    await loadA;
    expect(usePromptTemplatesStore.getState().prompts.map((p) => p.id)).toEqual(["b"]);
  });

  test("stale runtime completion does not commit", async () => {
    let resolveLoad!: (v: { skills: never[]; prompts: never[]; agents: never[] }) => void;
    resourcesImpl = () => new Promise((resolve) => { resolveLoad = resolve as never; });
    invalidatePromptTemplatesLoadCache("/work");
    const pending = usePromptTemplatesStore.getState().loadPrompts("/work");
    runtimeKey = "runtime-2";
    resolveLoad({ skills: [], prompts: [], agents: [] });
    expect(await pending).toBe(false);
  });

  test("refuses to update read-only package prompts", async () => {
    resourcesImpl = async () => ({
      skills: [],
      prompts: [{ id: "pkg", kind: "prompt", name: "pkg", location: "package", editable: false }],
      agents: [],
    });
    await usePromptTemplatesStore.getState().loadPrompts("/work");
    let called = false;
    updateImpl = async () => {
      called = true;
      return { skills: [], prompts: [], agents: [] };
    };
    expect(await usePromptTemplatesStore.getState().updatePrompt("pkg", { content: "x" }, "/work")).toBe(false);
    expect(called).toBe(false);
  });

  test("rename and scope move select the replacement opaque id", async () => {
    resourcesImpl = async () => ({
      skills: [],
      prompts: [{ id: "old", kind: "prompt", name: "review", location: "global", editable: true }],
      agents: [],
    });
    await usePromptTemplatesStore.getState().loadPrompts("/work");
    updateImpl = async () => ({
      skills: [],
      prompts: [{ id: "new", kind: "prompt", name: "review-project", location: "project", editable: true }],
      agents: [],
    });
    expect(await usePromptTemplatesStore.getState().updatePrompt("old", {
      name: "review-project",
      location: "project",
    }, "/work")).toBe(true);
    expect(usePromptTemplatesStore.getState().selectedPromptId).toBe("new");
  });

  test("an in-flight load cannot overwrite a newer mutation for the same directory", async () => {
    let resolveLoad!: (value: Awaited<ReturnType<typeof resourcesImpl>>) => void;
    resourcesImpl = () => new Promise((resolve) => { resolveLoad = resolve; });
    invalidatePromptTemplatesLoadCache("/work");
    const pendingLoad = usePromptTemplatesStore.getState().loadPrompts("/work");
    createImpl = async () => ({
      skills: [],
      prompts: [{ id: "new", kind: "prompt", name: "review", location: "global", editable: true }],
      agents: [],
    });
    expect(await usePromptTemplatesStore.getState().createPrompt("review", "Body", {
      description: "Review",
      location: "global",
      directory: "/work",
    })).toBe(true);
    resolveLoad({ skills: [], prompts: [], agents: [] });
    expect(await pendingLoad).toBe(true);
    expect(usePromptTemplatesStore.getState().prompts.map((prompt) => prompt.id)).toEqual(["new"]);
  });

  test("a mutation response cannot replace a newly active directory", async () => {
    resourcesImpl = async (directory) => ({
      skills: [],
      prompts: [{ id: directory === "/a" ? "a" : "b", kind: "prompt", name: directory === "/a" ? "a" : "b", location: "global", editable: true }],
      agents: [],
    });
    await usePromptTemplatesStore.getState().loadPrompts("/a");
    let resolveUpdate!: (value: Awaited<ReturnType<typeof resourcesImpl>>) => void;
    updateImpl = () => new Promise((resolve) => { resolveUpdate = resolve as typeof resolveUpdate; });
    const pending = usePromptTemplatesStore.getState().updatePrompt("a", { content: "updated" }, "/a");
    await usePromptTemplatesStore.getState().loadPrompts("/b");
    resolveUpdate({ skills: [], prompts: [{ id: "a", kind: "prompt", name: "a", location: "global", editable: true }], agents: [] });
    expect(await pending).toBe(true);
    expect(usePromptTemplatesStore.getState().prompts.map((prompt) => prompt.id)).toEqual(["b"]);
  });

  test("create carries explicit directory and selects the new prompt", async () => {
    resourcesImpl = async () => ({ skills: [], prompts: [], agents: [] });
    await usePromptTemplatesStore.getState().loadPrompts("/work");
    let seenDir: unknown = null;
    createImpl = async (_input: unknown, dir: unknown) => {
      seenDir = dir;
      return {
        skills: [],
        prompts: [{ id: "new", kind: "prompt", name: "review", location: "global", editable: true }],
        agents: [],
      };
    };
    expect(
      await usePromptTemplatesStore.getState().createPrompt("review", "Body $1 $@", {
        description: "Review",
        location: "global",
        directory: "/work",
      }),
    ).toBe(true);
    expect(seenDir).toBe("/work");
    expect(usePromptTemplatesStore.getState().selectedPromptId).toBe("new");
  });
});
