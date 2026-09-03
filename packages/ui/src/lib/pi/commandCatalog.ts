/**
 * Shared Pi slash-command catalog.
 *
 * Pi SDK 0.84.1 `getCommands()` (and `session.prompt()` resolution) defines the
 * executable identity:
 *
 * - prompt template: `/review`
 * - skill: `/skill:code-review`
 * - extension: registered `/name` including Pi-generated `:suffix`
 * - PiChamber system: `/undo`, `/compact`, etc. (intercepted before Pi)
 * - snippet: `#name` (never a slash command)
 *
 * The catalog exposes executable names so callers never reconstruct skill
 * syntax from flags. Display rows show `/invocationName` with a System /
 * Prompt / Skill / Extension label; a shorter skill bare name may appear as
 * secondary text only.
 *
 * Caches are keyed by runtime identity + effective directory. A failed fetch
 * preserves the last known catalog for the same scope and never becomes
 * authoritative empty success. Runtime switches clear every scope.
 */

import type { PiCommand } from "./protocol";

export type CatalogCommandSource = "system" | "prompt" | "skill" | "extension";

export interface CatalogCommand {
  id: string;
  /** Bare resource name (`code-review`). For skills this excludes the prefix. */
  name: string;
  /** Executable invocation without leading `/` (`skill:code-review`). */
  invocationName: string;
  source: CatalogCommandSource;
  description?: string;
  scope?: string;
}

const SYSTEM_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "undo", description: "Undo the last message" },
  { name: "redo", description: "Redo previously undone messages" },
  { name: "timeline", description: "Open the conversation timeline" },
  { name: "compact", description: "Compress session history using AI to reduce context size" },
];

export const buildSystemCatalogCommands = (): CatalogCommand[] =>
  SYSTEM_COMMANDS.map((command) => ({
    id: `system:${command.name}`,
    name: command.name,
    invocationName: command.name,
    source: "system",
    description: command.description,
  }));

/** Map `/api/pi/commands` rows (already executable) to catalog identity. */
export const toCatalogCommands = (commands: readonly PiCommand[]): CatalogCommand[] => {
  return commands.map((command) => {
    if (command.source === "skill") {
      // Server sends `skill:name`; keep the bare name for secondary display
      // while the executable invocation stays authoritative.
      const invocation = command.name.startsWith("skill:")
        ? command.name
        : `skill:${command.name}`;
      const bare = invocation.slice("skill:".length);
      return {
        id: `skill:${command.scope ?? "runtime"}:${invocation}`,
        name: bare,
        invocationName: invocation,
        source: "skill" as const,
        ...(command.description ? { description: command.description } : {}),
        ...(command.scope ? { scope: command.scope } : {}),
      };
    }
    if (command.source === "extension") {
      return {
        id: `extension:${command.scope ?? "runtime"}:${command.name}`,
        name: command.name,
        invocationName: command.name,
        source: "extension" as const,
        ...(command.description ? { description: command.description } : {}),
        ...(command.scope ? { scope: command.scope } : {}),
      };
    }
    return {
      id: `prompt:${command.scope ?? "runtime"}:${command.name}`,
      name: command.name,
      invocationName: command.name,
      source: "prompt" as const,
      ...(command.description ? { description: command.description } : {}),
      ...(command.scope ? { scope: command.scope } : {}),
    };
  });
};

/** Lowercased executable invocations for tokenizer membership checks. */
export const catalogInvocationSet = (commands: readonly Pick<CatalogCommand, "invocationName">[]): Set<string> => {
  const set = new Set<string>();
  for (const command of commands) set.add(command.invocationName.toLowerCase());
  return set;
};

type CacheEntry = { commands: CatalogCommand[] };

const cacheByScope = new Map<string, CacheEntry>();
let invalidationRevision = 0;
const invalidationListeners = new Set<() => void>();

const publishInvalidation = (): void => {
  invalidationRevision += 1;
  for (const listener of invalidationListeners) listener();
};

export const getCommandCatalogInvalidationRevision = (): number => invalidationRevision;

export const subscribeCommandCatalogInvalidation = (listener: () => void): (() => void) => {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
};
// Bounded ownership: at most 20 directory scopes per process (LRU by
// insertion order); runtime switches clear all. Prevents unbounded growth
// across many worktrees while keeping warm directory switches instant.
const MAX_CACHED_SCOPES = 20;

const commandCatalogCacheKey = (runtimeKey: string, directory?: string): string =>
  `${runtimeKey}\n${directory?.trim() ?? ""}`;

export const readCommandCatalogCache = (runtimeKey: string, directory?: string): CatalogCommand[] | undefined =>
  cacheByScope.get(commandCatalogCacheKey(runtimeKey, directory))?.commands;

export const writeCommandCatalogCache = (
  runtimeKey: string,
  directory: string | undefined,
  commands: CatalogCommand[],
): void => {
  const key = commandCatalogCacheKey(runtimeKey, directory);
  // Refresh recency for LRU bound.
  cacheByScope.delete(key);
  cacheByScope.set(key, { commands });
  while (cacheByScope.size > MAX_CACHED_SCOPES) {
    const oldest = cacheByScope.keys().next().value;
    if (typeof oldest !== 'string') break;
    cacheByScope.delete(oldest);
  }
};

export const invalidateCommandCatalogCache = (directory?: string | null): void => {
  if (typeof directory === "string" && directory.trim().length > 0) {
    const suffix = `\n${directory.trim()}`;
    for (const key of [...cacheByScope.keys()]) {
      if (key.endsWith(suffix)) cacheByScope.delete(key);
    }
  } else {
    cacheByScope.clear();
  }
  publishInvalidation();
};

export const clearCommandCatalogForRuntimeSwitch = (): void => {
  cacheByScope.clear();
  publishInvalidation();
};
