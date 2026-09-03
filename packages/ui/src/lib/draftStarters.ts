import type { IconName } from "@/components/icon/icons";

// A draft starter is a reference to an existing command or skill, pinned to the
// onboarding/draft welcome screen as a one-click chip. Scope (global vs project)
// is NOT stored here — it is encoded by which list the ref lives in (global =
// settings.json, project = project config), derived from the command/skill's own
// scope when pinned.
export type DraftStarterType = 'command' | 'skill';

export type DraftStarterRef = {
    type: DraftStarterType;
    name: string;
};

// These commands were removed from PiChamber. Keep their names only to clean
// up old persisted starter settings without bringing them back into the UI.
const REMOVED_PICHAMBER_COMMANDS = new Set([
    'summary',
    'plan-feature',
    'catch-up',
    'debug',
    'weigh',
    'explore',
]);

export const isRemovedPiChamberCommand = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.type === 'command'
        && typeof record.name === 'string'
        && REMOVED_PICHAMBER_COMMANDS.has(record.name.trim().toLowerCase());
};

// No PiChamber-owned command starters are enabled by default. Keep the empty
// default so older persisted starter settings remain readable without
// reintroducing removed commands.
export const DEFAULT_GLOBAL_STARTERS: readonly DraftStarterRef[] = [];

// Fallback icon for skill starters, matching the Settings section.
export const SKILL_FALLBACK_ICON: IconName = 'book-open';

export const starterKey = (ref: DraftStarterRef): string => `${ref.type}:${ref.name}`;

export const sameStarter = (a: DraftStarterRef, b: DraftStarterRef): boolean =>
    a.type === b.type && a.name === b.name;

// Turn a command/skill name into a human chip label: "/simplify-code" -> "Simplify code".
export const normalizeStarterLabel = (name: string): string => {
    const base = name
        .replace(/^\//, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!base) return name;
    return base.charAt(0).toUpperCase() + base.slice(1);
};

// Parse persisted starter refs (from settings.json or project config) defensively.
export const sanitizeStarterRefs = (value: unknown): DraftStarterRef[] => {
    if (!Array.isArray(value)) return [];
    const out: DraftStarterRef[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const type = record.type === 'command' || record.type === 'skill' ? record.type : null;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!type || !name || isRemovedPiChamberCommand({ type, name })) continue;
        const key = `${type}:${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type, name });
    }
    return out;
};
