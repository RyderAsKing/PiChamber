import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPiSnippetsStore } from "./snippets-store.js";

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const makeStore = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pichamber-snippets-"));
  directories.push(directory);
  return createPiSnippetsStore({
    file: join(directory, "pi", "snippets.json"),
  });
};

describe("Pi snippets store", () => {
  it("starts empty and round-trips a global snippet", async () => {
    const store = await makeStore();
    await expect(store.list()).resolves.toEqual([]);
    const snippets = await store.create({
      name: "review",
      content: "Review this",
      scope: "global",
    });
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({
      name: "review",
      content: "Review this",
      scope: "global",
    });
    expect(typeof snippets[0].id).toBe("string");
    await expect(store.list()).resolves.toEqual(snippets);
  });

  it("scopes project snippets by directory with project-over-global precedence in the caller", async () => {
    const store = await makeStore();
    await store.create({
      name: "review",
      content: "Global review",
      scope: "global",
    });
    await store.create({
      name: "review",
      content: "Project review",
      scope: "project",
      directory: "/workspace",
    });
    await expect(store.list()).resolves.toHaveLength(1);
    const scoped = await store.list("/workspace");
    expect(scoped).toHaveLength(2);
    await expect(store.list("/other")).resolves.toHaveLength(1);
  });

  it("rejects duplicate names case-insensitively within the same bucket", async () => {
    const store = await makeStore();
    await store.create({ name: "Review", content: "First", scope: "global" });
    await expect(
      store.create({ name: "review", content: "Second", scope: "global" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("rejects malformed input without replacing valid data", async () => {
    const store = await makeStore();
    await store.create({ name: "ok", content: "Content", scope: "global" });
    await expect(
      store.create({ name: "bad name!", content: "x", scope: "global" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      store.create({ name: "ok2", content: "", scope: "global" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("treats malformed files as invalid rather than empty", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pichamber-snippets-"));
    directories.push(directory);
    const file = join(directory, "snippets.json");
    await writeFile(file, "{ not json", "utf8");
    const store = createPiSnippetsStore({ file });
    await expect(store.list()).rejects.toMatchObject({
      code: "SNIPPETS_INVALID",
    });
    expect(await readFile(file, "utf8")).toBe("{ not json");
  });

  it("updates content and deletes by id", async () => {
    const store = await makeStore();
    const created = await store.create({
      name: "note",
      content: "Before",
      scope: "global",
    });
    const id = created[0].id;
    const updated = await store.update(id, { content: "After" });
    expect(updated[0]).toMatchObject({ id, content: "After" });
    const afterDelete = await store.remove(id);
    expect(afterDelete).toEqual([]);
  });

  it("returns not-found for unknown ids without clearing state", async () => {
    const store = await makeStore();
    await store.create({ name: "keep", content: "Content", scope: "global" });
    await expect(
      store.update("missing", { content: "x" }),
    ).rejects.toMatchObject({ code: "SNIPPET_NOT_FOUND" });
    await expect(store.remove("missing")).rejects.toMatchObject({
      code: "SNIPPET_NOT_FOUND",
    });
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("serializes the full read-modify-write transaction", async () => {
    const store = await makeStore();
    await Promise.all([
      store.create({ name: "first", content: "One", scope: "global" }),
      store.create({ name: "second", content: "Two", scope: "global" }),
    ]);
    await expect(store.list()).resolves.toHaveLength(2);
  });

  it("canonicalizes project directory keys", async () => {
    const store = await makeStore();
    await store.create({
      name: "project-note",
      content: "Note",
      scope: "project",
      directory: "/workspace/child/..",
    });
    await expect(store.list("/workspace")).resolves.toHaveLength(1);
    await expect(store.list("relative/path")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("does not update or delete a project snippet through another directory", async () => {
    const store = await makeStore();
    const created = await store.create({
      name: "private",
      content: "Before",
      scope: "project",
      directory: "/workspace-a",
    });
    const id = created.find((snippet) => snippet.scope === "project").id;
    await expect(
      store.update(id, { content: "After" }, "/workspace-b"),
    ).rejects.toMatchObject({ code: "SNIPPET_NOT_FOUND" });
    await expect(store.remove(id, "/workspace-b")).rejects.toMatchObject({
      code: "SNIPPET_NOT_FOUND",
    });
    await expect(store.list("/workspace-a")).resolves.toEqual(created);
  });

  it("distinguishes missing store from authoritative empty store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pichamber-snippets-"));
    directories.push(directory);
    const file = join(directory, "snippets.json");
    const store = createPiSnippetsStore({ file });
    await expect(store.list()).resolves.toEqual([]);
    const { stat } = await import("node:fs/promises");
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await store.create({ name: "a", content: "A", scope: "global" });
    await expect(store.list()).resolves.toHaveLength(1);
    await store.remove((await store.list())[0].id);
    await expect(store.list()).resolves.toEqual([]);
    await expect(readFile(file, "utf8")).resolves.toContain('"snippets": []');
  });

  it("renames by opaque id and rejects collisions without overwriting", async () => {
    const store = await makeStore();
    const created = await store.create({ name: "first", content: "One", scope: "global" });
    const id = created[0].id;
    await store.create({ name: "second", content: "Two", scope: "global" });
    const renamed = await store.update(id, { name: "renamed" });
    expect(renamed.find((s) => s.id === id)).toMatchObject({ name: "renamed" });
    await expect(store.update(id, { name: "SECOND" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(store.list()).resolves.toHaveLength(2);
    expect((await store.list()).find((s) => s.id === id)).toMatchObject({ name: "renamed" });
  });

  it("moves between global and project scopes with destination validation", async () => {
    const store = await makeStore();
    const created = await store.create({ name: "note", content: "Body", scope: "global" });
    const id = created[0].id;
    const moved = await store.update(id, { scope: "project", directory: "/workspace" }, "/workspace");
    expect(moved.find((s) => s.id === id)).toMatchObject({ scope: "project", directory: "/workspace" });
    await expect(store.list()).resolves.toHaveLength(0);
    await expect(store.list("/workspace")).resolves.toHaveLength(1);
    const back = await store.update(id, { scope: "global" }, "/workspace");
    expect(back.find((s) => s.id === id)).toMatchObject({ scope: "global" });
  });

  it("leaves the original intact when a scope move collides", async () => {
    const store = await makeStore();
    await store.create({ name: "note", content: "Project", scope: "project", directory: "/workspace" });
    const global = await store.create({ name: "other", content: "Global", scope: "global" });
    const id = global.find((s) => s.name === "other").id;
    await expect(store.update(id, { name: "NOTE", scope: "project", directory: "/workspace" }, "/workspace")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const after = await store.list("/workspace");
    expect(after).toHaveLength(2);
    expect(after.find((s) => s.id === id)).toMatchObject({ scope: "global", name: "other" });
  });

  it("edits aliases with case-insensitive collision checks", async () => {
    const store = await makeStore();
    const created = await store.create({ name: "note", content: "Body", scope: "global" });
    const id = created[0].id;
    const updated = await store.update(id, { aliases: ["shortcut", "alt"] });
    expect(updated[0]).toMatchObject({ aliases: ["shortcut", "alt"] });
    await store.create({ name: "other", content: "Other", scope: "global" });
    const otherId = (await store.list()).find((s) => s.name === "other").id;
    await expect(store.update(otherId, { aliases: ["SHORTCUT"] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(store.update(otherId, { name: "ALT" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("preserves the previous snapshot when a write fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pichamber-snippets-"));
    directories.push(directory);
    const file = join(directory, "snippets.json");
    const store = createPiSnippetsStore({ file });
    await store.create({ name: "keep", content: "Content", scope: "global" });
    const before = await readFile(file, "utf8");
    const failingFs = {
      ...(await import("node:fs/promises")),
      writeFile: async () => {
        const error = new Error("disk full");
        error.code = "ENOSPC";
        throw error;
      },
    };
    const failing = createPiSnippetsStore({ file, fs: failingFs });
    await expect(failing.create({ name: "lost", content: "x", scope: "global" })).rejects.toBeDefined();
    expect(await readFile(file, "utf8")).toBe(before);
    await expect(store.list()).resolves.toHaveLength(1);
  });
});
