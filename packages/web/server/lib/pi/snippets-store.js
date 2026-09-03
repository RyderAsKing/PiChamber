import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { resolvePiChamberDataDir } from "../pichamber-data-dir.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 200_000;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_ALIASES = 10;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const invalid = (code = "SNIPPETS_INVALID") => {
  const error = new Error("PiChamber snippets are invalid.");
  error.code = code;
  return error;
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeName = (value) =>
  typeof value === "string" ? value.trim() : "";

const validateName = (value) => {
  const name = normalizeName(value);
  if (!NAME_PATTERN.test(name)) throw invalid("INVALID_ARGUMENT");
  return name;
};

const validateContent = (value) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CONTENT_CHARS
  ) {
    throw invalid("INVALID_ARGUMENT");
  }
  return value;
};

const validateDescription = (value) => {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_CHARS)
    throw invalid("INVALID_ARGUMENT");
  return value;
};

const validateAliases = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ALIASES)
    throw invalid("INVALID_ARGUMENT");
  const seen = new Set();
  const aliases = [];
  for (const entry of value) {
    const alias = normalizeName(entry);
    if (!NAME_PATTERN.test(alias)) throw invalid("INVALID_ARGUMENT");
    const lower = alias.toLowerCase();
    if (seen.has(lower)) throw invalid("INVALID_ARGUMENT");
    seen.add(lower);
    aliases.push(alias);
  }
  return aliases;
};

const validateScope = (value) => {
  if (value !== "global" && value !== "project")
    throw invalid("INVALID_ARGUMENT");
  return value;
};

const validateDirectory = (value, scope) => {
  if (scope === "global") return null;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 2048
  ) {
    throw invalid("INVALID_ARGUMENT");
  }
  const trimmed = value.trim();
  if (trimmed === "~") return trimmed;
  if (!isAbsolute(trimmed)) throw invalid("INVALID_ARGUMENT");
  return normalize(trimmed);
};

const validateSnippetRecord = (value) => {
  if (!isRecord(value)) throw invalid();
  const id =
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128
      ? value.id
      : null;
  if (!id) throw invalid();
  const name = validateName(value.name);
  if (
    typeof value.content !== "string" ||
    value.content.length === 0 ||
    value.content.length > MAX_CONTENT_CHARS
  )
    throw invalid();
  const description = validateDescription(value.description);
  const aliases = validateAliases(value.aliases);
  const scope = validateScope(value.scope);
  const directory =
    scope === "project" ? validateDirectory(value.directory, scope) : null;
  const createdAt =
    Number.isSafeInteger(value.createdAt) && value.createdAt > 0
      ? value.createdAt
      : null;
  const updatedAt =
    Number.isSafeInteger(value.updatedAt) && value.updatedAt > 0
      ? value.updatedAt
      : null;
  if (!createdAt || !updatedAt) throw invalid();
  return {
    id,
    name,
    content: value.content,
    description,
    aliases,
    scope,
    directory,
    createdAt,
    updatedAt,
  };
};

const validateSnapshot = (value) => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.snippets))
    throw invalid();
  const snippets = value.snippets.map(validateSnippetRecord);
  const ids = new Set();
  for (const snippet of snippets) {
    if (ids.has(snippet.id)) throw invalid();
    ids.add(snippet.id);
    try {
      assertUniqueInBucket(snippets, snippet, snippet.id);
    } catch {
      throw invalid();
    }
  }
  const snapshot = { version: 1, snippets };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_FILE_BYTES)
    throw invalid();
  return snapshot;
};

const bucketKey = (snippet) =>
  snippet.scope === "project" ? `project:${snippet.directory ?? ""}` : "global";

const assertUniqueInBucket = (snippets, candidate, ignoreId) => {
  const bucket = bucketKey(candidate);
  const taken = new Map();
  for (const snippet of snippets) {
    if (snippet.id === ignoreId) continue;
    if (bucketKey(snippet) !== bucket) continue;
    taken.set(snippet.name.toLowerCase(), snippet.name);
    for (const alias of snippet.aliases ?? [])
      taken.set(alias.toLowerCase(), alias);
  }
  const candidateTokens = [candidate.name, ...(candidate.aliases ?? [])].map(
    (token) => token.toLowerCase(),
  );
  const seenCandidate = new Set();
  for (const token of candidateTokens) {
    if (seenCandidate.has(token)) throw invalid("INVALID_ARGUMENT");
    seenCandidate.add(token);
    if (taken.has(token)) {
      const error = invalid("INVALID_ARGUMENT");
      error.message = "A PiChamber snippet with that name already exists.";
      throw error;
    }
  }
};

export const createPiSnippetsStore = ({
  file = join(resolvePiChamberDataDir(), "pi", "snippets.json"),
  fs = { chmod, mkdir, readFile, rename, rm, writeFile },
} = {}) => {
  let mutation = Promise.resolve();

  const readRaw = async () => {
    try {
      const raw = await fs.readFile(file, "utf8");
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw invalid();
      return validateSnapshot(JSON.parse(raw));
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, snippets: [] };
      if (
        error?.code === "SNIPPETS_INVALID" ||
        error?.code === "INVALID_ARGUMENT"
      )
        throw error;
      throw invalid();
    }
  };

  const writeRaw = async (snapshot) => {
    const validated = validateSnapshot(snapshot);
    const parent = dirname(file);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    if (process.platform !== "win32")
      await fs.chmod(file, 0o600).catch(() => {});
    return validated;
  };

  const snippetsForDirectory = (snapshot, directory) => {
    const wanted =
      typeof directory === "string" && directory.trim().length > 0
        ? validateDirectory(directory, "project")
        : null;
    return snapshot.snippets.filter(
      (snippet) =>
        snippet.scope === "global" ||
        (wanted !== null && snippet.directory === wanted),
    );
  };

  const transact = (operation) => {
    const pending = mutation.then(operation);
    mutation = pending.catch(() => {});
    return pending;
  };

  const list = async (directory) => {
    await mutation;
    return snippetsForDirectory(await readRaw(), directory);
  };

  const create = async (input) => {
    return transact(async () => {
      if (!isRecord(input)) throw invalid("INVALID_ARGUMENT");
      for (const key of Object.keys(input)) {
        if (FORBIDDEN_KEYS.has(key)) throw invalid("INVALID_ARGUMENT");
      }
      const allowedCreateKeys = new Set([
        "name",
        "content",
        "description",
        "aliases",
        "scope",
        "directory",
      ]);
      for (const key of Object.keys(input)) {
        if (!allowedCreateKeys.has(key)) throw invalid("INVALID_ARGUMENT");
      }
      const scope = validateScope(input.scope ?? "global");
      const directory = validateDirectory(input.directory, scope);
      const candidate = {
        id: randomUUID(),
        name: validateName(input.name),
        content: validateContent(input.content),
        description: validateDescription(input.description),
        aliases: validateAliases(input.aliases),
        scope,
        directory,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const snapshot = await readRaw();
      assertUniqueInBucket(snapshot.snippets, candidate, null);
      const next = await writeRaw({
        version: 1,
        snippets: [...snapshot.snippets, candidate],
      });
      return snippetsForDirectory(next, directory);
    });
  };

  const update = async (id, input, directory) => {
    return transact(async () => {
      if (typeof id !== "string" || id.length === 0 || id.length > 128)
        throw invalid("INVALID_ARGUMENT");
      if (!isRecord(input)) throw invalid("INVALID_ARGUMENT");
      for (const key of Object.keys(input)) {
        if (FORBIDDEN_KEYS.has(key)) throw invalid("INVALID_ARGUMENT");
      }
      const allowedKeys = new Set([
        "name",
        "content",
        "description",
        "aliases",
        "scope",
        "directory",
      ]);
      for (const key of Object.keys(input)) {
        if (!allowedKeys.has(key)) throw invalid("INVALID_ARGUMENT");
      }
      const snapshot = await readRaw();
      const index = snapshot.snippets.findIndex((snippet) => snippet.id === id);
      if (index === -1) {
        const error = invalid("INVALID_ARGUMENT");
        error.code = "SNIPPET_NOT_FOUND";
        throw error;
      }
      const current = snapshot.snippets[index];
      const wanted =
        typeof directory === "string" && directory.trim().length > 0
          ? validateDirectory(directory, "project")
          : null;
      if (current.scope === "project" && current.directory !== wanted) {
        const error = invalid("INVALID_ARGUMENT");
        error.code = "SNIPPET_NOT_FOUND";
        throw error;
      }
      const nextName =
        input.name !== undefined ? validateName(input.name) : current.name;
      const nextScope =
        input.scope !== undefined ? validateScope(input.scope) : current.scope;
      let nextDirectory = current.directory;
      if (nextScope === "global") {
        nextDirectory = null;
      } else if (input.directory !== undefined) {
        nextDirectory = validateDirectory(input.directory, "project");
      } else if (current.scope === "project") {
        nextDirectory = current.directory;
      } else {
        nextDirectory = wanted;
      }
      if (nextScope === "project" && nextDirectory === null) {
        throw invalid("INVALID_ARGUMENT");
      }
      const nextSnippet = {
        ...current,
        name: nextName,
        scope: nextScope,
        directory: nextDirectory,
        ...(input.content !== undefined
          ? { content: validateContent(input.content) }
          : {}),
        ...(input.description !== undefined
          ? { description: validateDescription(input.description) }
          : {}),
        ...(input.aliases !== undefined
          ? { aliases: validateAliases(input.aliases) }
          : {}),
        updatedAt: Date.now(),
      };
      assertUniqueInBucket(snapshot.snippets, nextSnippet, id);
      const next = await writeRaw({
        version: 1,
        snippets: snapshot.snippets.map((snippet, i) =>
          i === index ? nextSnippet : snippet,
        ),
      });
      return snippetsForDirectory(next, wanted ?? nextDirectory);
    });
  };

  const remove = async (id, directory) => {
    return transact(async () => {
      if (typeof id !== "string" || id.length === 0)
        throw invalid("INVALID_ARGUMENT");
      const snapshot = await readRaw();
      const existing = snapshot.snippets.find((snippet) => snippet.id === id);
      if (!existing) {
        const error = invalid("INVALID_ARGUMENT");
        error.code = "SNIPPET_NOT_FOUND";
        throw error;
      }
      const wanted =
        typeof directory === "string" && directory.trim().length > 0
          ? validateDirectory(directory, "project")
          : null;
      if (existing.scope === "project" && existing.directory !== wanted) {
        const error = invalid("INVALID_ARGUMENT");
        error.code = "SNIPPET_NOT_FOUND";
        throw error;
      }
      const next = await writeRaw({
        version: 1,
        snippets: snapshot.snippets.filter((snippet) => snippet.id !== id),
      });
      return snippetsForDirectory(next, wanted);
    });
  };

  return { file, list, create, update, remove };
};
