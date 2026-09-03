import { beforeEach, describe, expect, mock, test } from "bun:test";

let snippetsImpl: (directory?: string) => Promise<{
  snippets: Array<{
    id: string;
    name: string;
    content: string;
    aliases: string[];
    scope: "global" | "project";
    directory?: string;
  }>;
}>;
let createImpl: (input: unknown) => Promise<{ snippets: unknown[] }> = async () => ({ snippets: [] });
let updateImpl: (id: string, input: unknown, directory?: string) => Promise<{ snippets: unknown[] }> = async () => ({ snippets: [] });
let deleteImpl: (id: string, directory?: string) => Promise<{ snippets: unknown[] }> = async () => ({ snippets: [] });
let runtimeKey = "runtime-1";

mock.module("@/lib/pi/client", () => ({
  piClient: {
    listSnippets: (directory?: string) => snippetsImpl(directory),
    createSnippet: (input: unknown) => createImpl(input),
    updateSnippet: (id: string, input: unknown, directory?: string) => updateImpl(id, input, directory),
    deleteSnippet: (id: string, directory?: string) => deleteImpl(id, directory),
  },
}));
mock.module("@/lib/runtime-switch", () => ({
  getRuntimeKey: () => runtimeKey,
}));

const { invalidateSnippetsLoadCache, useSnippetsStore } =
  await import("./useSnippetsStore");

describe("useSnippetsStore", () => {
  beforeEach(() => {
    runtimeKey = "runtime-1";
    createImpl = async () => ({ snippets: [] });
    updateImpl = async () => ({ snippets: [] });
    deleteImpl = async () => ({ snippets: [] });
    snippetsImpl = async () => ({
      snippets: [
        {
          id: "s1",
          name: "note",
          content: "Content",
          aliases: [],
          scope: "global",
        },
      ],
    });
    invalidateSnippetsLoadCache();
    useSnippetsStore.setState({
      selectedSnippetId: null,
      activeCacheKey: "",
      snippets: [],
      isLoading: false,
      snippetDraft: null,
    });
  });

  test("maps PiChamber snippets without Pi prompt-template state", async () => {
    expect(await useSnippetsStore.getState().loadSnippets("/work")).toBe(true);
    expect(useSnippetsStore.getState().snippets).toEqual([
      {
        id: "s1",
        name: "note",
        content: "Content",
        aliases: [],
        source: "global",
      },
    ]);
  });

  test("expands #name tokens literally without Pi template variables", async () => {
    await useSnippetsStore.getState().loadSnippets("/work");
    expect(
      useSnippetsStore.getState().expandText("Use #note now", "/work"),
    ).toBe("Use Content now");
    expect(
      useSnippetsStore.getState().expandText("Keep $1 and $@", "/work"),
    ).toBe("Keep $1 and $@");
  });

  test("preserves cached snippets until an explicit invalidation", async () => {
    let calls = 0;
    snippetsImpl = async () => {
      calls += 1;
      return { snippets: [] };
    };
    await useSnippetsStore.getState().loadSnippets("/work");
    await useSnippetsStore.getState().loadSnippets("/work");
    expect(calls).toBe(1);
    invalidateSnippetsLoadCache("/work");
    await useSnippetsStore.getState().loadSnippets("/work");
    expect(calls).toBe(2);
  });

  test("fetch failure preserves prior snippets instead of clearing to empty", async () => {
    await useSnippetsStore.getState().loadSnippets("/work");
    snippetsImpl = async () => {
      throw new Error("unavailable");
    };
    invalidateSnippetsLoadCache("/work");
    expect(await useSnippetsStore.getState().loadSnippets("/work")).toBe(false);
    expect(useSnippetsStore.getState().snippets).toHaveLength(1);
  });

  test("does not let a slower directory response replace the active directory", async () => {
    let resolveA!: (value: Awaited<ReturnType<typeof snippetsImpl>>) => void;
    let resolveB!: (value: Awaited<ReturnType<typeof snippetsImpl>>) => void;
    snippetsImpl = (directory) =>
      new Promise((resolve) => {
        if (directory === "/a") resolveA = resolve;
        else resolveB = resolve;
      });
    invalidateSnippetsLoadCache("/a");
    invalidateSnippetsLoadCache("/b");
    const loadA = useSnippetsStore.getState().loadSnippets("/a");
    const loadB = useSnippetsStore.getState().loadSnippets("/b");
    resolveB({
      snippets: [
        { id: "b", name: "b", content: "B", aliases: [], scope: "global" },
      ],
    });
    await loadB;
    resolveA({
      snippets: [
        { id: "a", name: "a", content: "A", aliases: [], scope: "global" },
      ],
    });
    await loadA;
    expect(
      useSnippetsStore.getState().snippets.map((snippet) => snippet.id),
    ).toEqual(["b"]);
  });

  test("uses project snippets before global snippets with the same name", async () => {
    snippetsImpl = async () => ({
      snippets: [
        {
          id: "global",
          name: "note",
          content: "Global",
          aliases: [],
          scope: "global",
        },
        {
          id: "project",
          name: "note",
          content: "Project",
          aliases: [],
          scope: "project",
          directory: "/work",
        },
      ],
    });
    invalidateSnippetsLoadCache("/work");
    await useSnippetsStore.getState().loadSnippets("/work");
    expect(useSnippetsStore.getState().expandText("#note", "/work")).toBe(
      "Project",
    );
  });

  test("expands aliases literally and keeps $1/$@ literal", async () => {
    snippetsImpl = async () => ({
      snippets: [
        { id: "s1", name: "note", content: "Hello $1 $@", aliases: ["n"], scope: "global" },
      ],
    });
    invalidateSnippetsLoadCache("/work");
    await useSnippetsStore.getState().loadSnippets("/work");
    expect(useSnippetsStore.getState().expandText("Use #n now", "/work")).toBe(
      "Use Hello $1 $@ now",
    );
  });

  test("update passes rename, aliases, and scope moves by opaque id", async () => {
    snippetsImpl = async () => ({
      snippets: [{ id: "s1", name: "note", content: "Body", aliases: [], scope: "global" }],
    });
    invalidateSnippetsLoadCache("/work");
    await useSnippetsStore.getState().loadSnippets("/work");
    let seen: { id: string; input: unknown; directory?: string } | null = null;
    const setSeen = (v: { id: string; input: unknown; directory?: string }) => { seen = v; };
    updateImpl = async (id: string, input: unknown, directory?: string) => {
      setSeen({ id, input, directory });
      return {
        snippets: [{ id: "s1", name: "renamed", content: "Body", aliases: ["r"], scope: "project", directory: "/work" }],
      };
    };
    expect(
      await useSnippetsStore.getState().updateSnippet(
        "s1",
        { name: "renamed", aliases: ["r"], scope: "project", directory: "/work" },
        "/work",
      ),
    ).toBe(true);
    const observed = seen as { id: string; input: Record<string, unknown> } | null;
    expect(observed?.id).toBe("s1");
    expect(observed?.input["name"]).toBe("renamed");
    expect(observed?.input["scope"]).toBe("project");
    expect(useSnippetsStore.getState().snippets[0]?.name).toBe("renamed");
  });

  test("an in-flight load cannot overwrite a newer mutation for the same directory", async () => {
    let resolveLoad!: (value: Awaited<ReturnType<typeof snippetsImpl>>) => void;
    snippetsImpl = () => new Promise((resolve) => { resolveLoad = resolve; });
    invalidateSnippetsLoadCache("/work");
    const pendingLoad = useSnippetsStore.getState().loadSnippets("/work");
    createImpl = async () => ({
      snippets: [{ id: "new", name: "note", content: "Body", aliases: [], scope: "global" }],
    });
    expect(await useSnippetsStore.getState().createSnippet("note", "Body", {
      scope: "global",
      directory: "/work",
    })).toBe(true);
    resolveLoad({ snippets: [] });
    expect(await pendingLoad).toBe(true);
    expect(useSnippetsStore.getState().snippets.map((snippet) => snippet.id)).toEqual(["new"]);
  });

  test("failed update preserves the previous snapshot", async () => {
    snippetsImpl = async () => ({
      snippets: [{ id: "s1", name: "note", content: "Body", aliases: [], scope: "global" }],
    });
    invalidateSnippetsLoadCache("/work");
    await useSnippetsStore.getState().loadSnippets("/work");
    updateImpl = async () => {
      throw new Error("collision");
    };
    expect(await useSnippetsStore.getState().updateSnippet("s1", { name: "other" }, "/work")).toBe(false);
    expect(useSnippetsStore.getState().snippets[0]?.name).toBe("note");
  });

  test("rejects stale runtime completions", async () => {
    snippetsImpl = async () => ({
      snippets: [{ id: "s1", name: "note", content: "Body", aliases: [], scope: "global" }],
    });
    invalidateSnippetsLoadCache("/work");
    await useSnippetsStore.getState().loadSnippets("/work");
    expect(useSnippetsStore.getState().snippets).toHaveLength(1);
    let resolveLoad!: (value: { snippets: never[] }) => void;
    snippetsImpl = () => new Promise((resolve) => { resolveLoad = resolve as never; });
    invalidateSnippetsLoadCache("/work");
    const pending = useSnippetsStore.getState().loadSnippets("/work");
    runtimeKey = "runtime-2";
    resolveLoad({ snippets: [] });
    expect(await pending).toBe(false);
    expect(useSnippetsStore.getState().snippets).toHaveLength(1);
    runtimeKey = "runtime-1";
  });

  test("cross-directory delete failure preserves state", async () => {
    snippetsImpl = async () => ({
      snippets: [{ id: "s1", name: "note", content: "Body", aliases: [], scope: "project", directory: "/a" }],
    });
    invalidateSnippetsLoadCache("/a");
    await useSnippetsStore.getState().loadSnippets("/a");
    deleteImpl = async () => { throw new Error("not found"); };
    expect(await useSnippetsStore.getState().deleteSnippet("s1", "/b")).toBe(false);
    expect(useSnippetsStore.getState().snippets).toHaveLength(1);
  });
});
