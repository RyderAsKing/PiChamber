import type { IconName } from "@/components/icon/icons";

/**
 * Draft starters are pinned Pi prompt templates shown on the new-session
 * welcome screen. They insert (never submit) the native `/name` command Pi
 * expands via `session.prompt()`.
 *
 * - Prompt templates use `/name` (Pi-owned).
 * - Skills use `/skill:name` (available via `/` autocomplete, never starters).
 * - Extension commands use their registered `/name` (autocomplete only).
 * - Snippets use `#name` (never starters, never slash commands).
 *
 * Scope (global vs project) is encoded by which list the ref lives in
 * (global = settings.json, project = project config), derived from the
 * prompt's own location when pinned. The optional `scope` field records that
 * origin for debugging/rename handling but never overrides list ownership.
 */
export type DraftStarterType = 'prompt';

export type DraftStarterRef = {
    type: DraftStarterType;
    name: string;
    scope?: 'global' | 'project';
};

// No prompt starters by default. Older skill/command starters are never
// converted: a skill and a prompt with the same name are not equivalent.
export const DEFAULT_GLOBAL_STARTERS: readonly DraftStarterRef[] = [];

// Fallback icon for prompt starters, matching the Settings section.
export const PROMPT_FALLBACK_ICON: IconName = 'book-open';

// Pi derives prompt names from filenames and resolves any non-whitespace
// command name. The CRUD UI creates a narrower portable subset, but existing
// Pi prompts such as `review.v2.md` must still be pinnable.
const PROMPT_NAME_PATTERN = /^[^\s/]+$/;

export const starterKey = (ref: DraftStarterRef): string => `${ref.type}:${ref.name}`;

export const sameStarter = (a: DraftStarterRef, b: DraftStarterRef): boolean =>
    a.type === b.type && a.name === b.name;

// Turn a prompt name into a human chip label: "review-code" -> "Review code".
export const normalizeStarterLabel = (name: string): string => {
    const base = name
        .replace(/^\//, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!base) return name;
    return base.charAt(0).toUpperCase() + base.slice(1);
};

/**
 * Parse persisted starter refs defensively.
 *
 * - Preserves valid new `{type:'prompt', name}` records.
 * - Drops legacy `{type:'skill'}` and retired `{type:'command'}` without
 *   conversion (a same-named prompt is not equivalent).
 * - Never invents prompt starters from matching names.
 * - Idempotent: sanitizing an already-clean list returns an equal list so
 *   callers can skip redundant persistence writes.
 */
export const sanitizeStarterRefs = (value: unknown): DraftStarterRef[] => {
    if (!Array.isArray(value)) return [];
    const out: DraftStarterRef[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        // Legacy skill/command records are parsed (not thrown) but never
        // preserved; they are removed on next sanitize/persist.
        if (record.type !== 'prompt') continue;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!name || !PROMPT_NAME_PATTERN.test(name)) continue;
        const scope = record.scope === 'global' || record.scope === 'project'
            ? record.scope
            : undefined;
        const key = `prompt:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(scope ? { type: 'prompt', name, scope } : { type: 'prompt', name });
    }
    return out;
};

type PromptCatalogEntry = {
    name: string;
    location: string;
    editable: boolean;
};

/**
 * Pick the Pi `/name` winner for duplicate prompt names.
 *
 * A project prompt may override a same-named global prompt in Pi discovery;
 * the pinned starter must resolve to the same prompt `/name` would invoke.
 * Rank: project > global > package/path, with editable top-level preferred.
 */
export const pickPromptWinner = (
    candidates: readonly PromptCatalogEntry[],
): PromptCatalogEntry | undefined => {
    let winner: PromptCatalogEntry | undefined;
    let winnerRank = -1;
    for (const candidate of candidates) {
        const base = candidate.location === 'project' ? 2 : candidate.location === 'global' ? 1 : 0;
        const rank = base + (candidate.editable ? 0.5 : 0);
        if (rank > winnerRank) {
            winner = candidate;
            winnerRank = rank;
        }
    }
    return winner;
};

export const buildPromptWinnerMap = (
    prompts: readonly PromptCatalogEntry[],
): Map<string, PromptCatalogEntry> => {
    const byName = new Map<string, PromptCatalogEntry[]>();
    for (const prompt of prompts) {
        const list = byName.get(prompt.name) ?? [];
        list.push(prompt);
        byName.set(prompt.name, list);
    }
    const winners = new Map<string, PromptCatalogEntry>();
    for (const [name, candidates] of byName) {
        const winner = pickPromptWinner(candidates);
        if (winner) winners.set(name, winner);
    }
    return winners;
};

/**
 * Dedupe starter invocations (`/name` trimmed). Project override claims the
 * invocation first so identical global duplicates never render twice.
 */
export const dedupeStarterInvocations = <T extends { insertText: string }>(
    project: readonly T[],
    global: readonly T[],
): { project: T[]; global: T[] } => {
    const seen = new Set<string>();
    const dedupe = (list: readonly T[]): T[] =>
        list.filter((item) => {
            const key = item.insertText.trim();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    const dedupedProject = dedupe(project);
    const dedupedGlobal = dedupe(global);
    return { project: dedupedProject, global: dedupedGlobal };
};
