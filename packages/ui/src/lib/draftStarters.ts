import type { IconName } from "@/components/icon/icons";

/**
 * Draft starters shown on the new-session welcome screen. They insert text
 * (never submit).
 *
 * - Prompt templates insert the native `/name` command Pi expands via
 *   `session.prompt()` (Pi-owned).
 * - Built-in text starters insert literal prompt text (PiChamber-owned
 *   one-time defaults, never pinnable).
 * - Skills use `/skill:name` (available via `/` autocomplete, never starters).
 * - Extension commands use their registered `/name` (autocomplete only).
 * - Snippets use `#name` (never starters, never slash commands).
 *
 * Scope (global vs project) is encoded by which list the ref lives in
 * (global = settings.json, project = project config), derived from the
 * prompt's own location when pinned. The optional `scope` field records that
 * origin for debugging/rename handling but never overrides list ownership.
 */
export type DraftStarterType = 'prompt' | 'text';

export type DraftStarterPromptRef = {
    type: 'prompt';
    name: string;
    scope?: 'global' | 'project';
};

export type BuiltinTextStarterKey =
    | 'explore'
    | 'plan'
    | 'review'
    | 'find-bugs'
    | 'write-tests';

export type DraftStarterTextRef = {
    type: 'text';
    key: BuiltinTextStarterKey;
};

export type DraftStarterRef = DraftStarterPromptRef | DraftStarterTextRef;

// Built-in text starters shown on fresh installs. They insert literal prompt
// text (never a `/name` template) and are intentionally not pinnable: once
// removed they cannot be added back via the picker.
export const BUILTIN_TEXT_STARTERS: Record<
    BuiltinTextStarterKey,
    { label: string; icon: IconName; text: string }
> = {
    explore: {
        label: 'Explore the codebase',
        icon: 'compass-3',
        text: 'Explore this codebase and explain how it works. Start with an overview, then key files and data flow.',
    },
    plan: {
        label: 'Plan the work',
        icon: 'list-check-2',
        text: 'Plan this work before coding. Break it into small steps, list files to change, and call out risks.',
    },
    review: {
        label: 'Review my changes',
        icon: 'file-search',
        text: 'Review my current changes for bugs, edge cases, and regressions. Suggest specific fixes.',
    },
    'find-bugs': {
        label: 'Find bugs',
        icon: 'bug',
        text: 'Find bugs in the current selection. List each issue with what is wrong and a minimal fix.',
    },
    'write-tests': {
        label: 'Write tests',
        icon: 'flask',
        text: 'Write tests for the current selection. Cover the happy path, edge cases, and failure modes.',
    },
};

export const BUILTIN_TEXT_STARTER_KEYS = Object.keys(
    BUILTIN_TEXT_STARTERS,
) as BuiltinTextStarterKey[];

const isBuiltinTextStarterKey = (value: unknown): value is BuiltinTextStarterKey =>
    typeof value === 'string' &&
    (value === 'explore' ||
        value === 'plan' ||
        value === 'review' ||
        value === 'find-bugs' ||
        value === 'write-tests');

// One-time defaults for fresh installs (`globalDraftStarters === null`).
// Removing a chip persists the remaining list, so dismissed defaults never
// reappear. Older skill/command starters are never converted: a skill and a
// prompt with the same name are not equivalent.
export const DEFAULT_GLOBAL_STARTERS: readonly DraftStarterRef[] = [
    { type: 'text', key: 'explore' },
    { type: 'text', key: 'plan' },
    { type: 'text', key: 'review' },
    { type: 'text', key: 'find-bugs' },
    { type: 'text', key: 'write-tests' },
];

// Fallback icon for prompt starters, matching the Settings section.
export const PROMPT_FALLBACK_ICON: IconName = 'book-open';

// Pi derives prompt names from filenames and resolves any non-whitespace
// command name. The CRUD UI creates a narrower portable subset, but existing
// Pi prompts such as `review.v2.md` must still be pinnable.
const PROMPT_NAME_PATTERN = /^[^\s/]+$/;

export const starterKey = (ref: DraftStarterRef): string =>
    ref.type === 'prompt' ? `prompt:${ref.name}` : `text:${ref.key}`;

export const sameStarter = (a: DraftStarterRef, b: DraftStarterRef): boolean => {
    if (a.type !== b.type) return false;
    if (a.type === 'prompt' && b.type === 'prompt') return a.name === b.name;
    if (a.type === 'text' && b.type === 'text') return a.key === b.key;
    return false;
};

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
 * - Preserves valid `{type:'prompt', name}` records.
 * - Preserves valid built-in `{type:'text', key}` records (only known
 *   builtin keys; arbitrary text is dropped).
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
        if (record.type === 'text') {
            if (!isBuiltinTextStarterKey(record.key)) continue;
            const ref: DraftStarterRef = { type: 'text', key: record.key };
            const key = starterKey(ref);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(ref);
            continue;
        }
        // Legacy skill/command records are parsed (not thrown) but never
        // preserved; they are removed on next sanitize/persist.
        if (record.type !== 'prompt') continue;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!name || !PROMPT_NAME_PATTERN.test(name)) continue;
        const scope = record.scope === 'global' || record.scope === 'project'
            ? record.scope
            : undefined;
        const ref: DraftStarterRef = scope
            ? { type: 'prompt', name, scope }
            : { type: 'prompt', name };
        const key = starterKey(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
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
