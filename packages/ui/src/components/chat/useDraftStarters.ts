import React from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { useUIStore } from '@/stores/useUIStore';
import {
    promptTemplatesCacheKey,
    usePromptTemplatesStore,
} from '@/stores/usePromptTemplatesStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { updateDesktopSettings } from '@/lib/persistence';
import { getProjectDraftStarters, saveProjectDraftStarters } from '@/lib/pichamberConfig';
import type { IconName } from '@/components/icon/icons';
import {
    BUILTIN_TEXT_STARTERS,
    DEFAULT_GLOBAL_STARTERS,
    PROMPT_FALLBACK_ICON,
    buildPromptWinnerMap,
    dedupeStarterInvocations,
    normalizeStarterLabel,
    sameStarter,
    starterKey,
    type DraftStarterRef,
} from '@/lib/draftStarters';

type StarterGroup = 'global' | 'project';
const EMPTY_PROMPTS: never[] = [];

export type ResolvedStarter = {
    id: string;
    ref: DraftStarterRef;
    group: StarterGroup;
    label: string;
    icon: IconName;
    /**
     * Text to insert into the composer. Prompt starters use the native
     * `/name ` invocation; built-in text starters use literal prompt text.
     */
    insertText: string;
    /** Bare prompt name for `/name` starters; empty for built-in text. */
    promptName: string;
};

export type PinnableSection = 'prompt';

export type PinnableItem = {
    type: 'prompt';
    name: string;
    label: string;
    icon: IconName;
    section: PinnableSection;
    scope: 'user' | 'project';
};

const chipId = (group: StarterGroup, ref: DraftStarterRef): string => `${group}:${starterKey(ref)}`;

export type UseDraftStartersResult = {
    global: ResolvedStarter[];
    project: ResolvedStarter[];
    pinnable: PinnableItem[];
    hasProject: boolean;
    ensureLoaded: () => void;
    addStarter: (item: PinnableItem) => void;
    removeStarter: (group: StarterGroup, ref: DraftStarterRef) => void;
    reorder: (group: StarterGroup, fromId: string, toId: string) => void;
};

/**
 * Draft starters for the effective new-session directory: pinned Pi
 * prompt-template starters plus built-in text starters.
 *
 * - Lists editable, invokable native prompts from the authoritative
 *   prompt-template store (never snippets, never skills, never files).
 * - Built-in text starters resolve locally without a catalog lookup.
 * - Global starters persist in PiChamber global settings; project starters in
 *   project config, resolved against the effective draft directory (not merely
 *   the sidebar selection).
 * - A project prompt may override a same-named global prompt; resolution
 *   matches Pi's `/name` execution and never shows two chips with the same
 *   invocation.
 * - Only a successful authoritative catalog marks a prompt starter
 *   unresolved; fetch failure preserves the last known resolution.
 */
export function useDraftStarters(): UseDraftStartersResult {
    const globalRaw = useUIStore((s) => s.globalDraftStarters);
    const prompts = usePromptTemplatesStore((s) => s.prompts);
    const activePromptCacheKey = usePromptTemplatesStore((s) => s.activeCacheKey);
    const loadPrompts = usePromptTemplatesStore((s) => s.loadPrompts);
    const activeProjectId = useProjectsStore((s) => s.activeProjectId);
    const projects = useProjectsStore((s) => s.projects);
    const effectiveDirectory = useEffectiveDirectory();

    const projectRef = React.useMemo(() => {
        if (!activeProjectId) return null;
        const found = projects.find((p) => p.id === activeProjectId);
        if (!found?.path) return null;
        return { id: found.id, path: found.path };
    }, [activeProjectId, projects]);

    const [projectStarters, setProjectStarters] = React.useState<DraftStarterRef[]>([]);
    // Tracks directories with at least one successful authoritative prompt
    // fetch. Only those may mark a starter unresolved (deletion); failures
    // and never-loaded scopes preserve the last known resolution.
    const authoritativeDirsRef = React.useRef<Set<string>>(new Set());
    const [authoritativeTick, setAuthoritativeTick] = React.useState(0);

    React.useEffect(() => {
        let cancelled = false;
        if (!projectRef) {
            setProjectStarters([]);
            return;
        }
        getProjectDraftStarters(projectRef)
            .then((refs) => { if (!cancelled) setProjectStarters(refs); })
            .catch(() => { if (!cancelled) setProjectStarters([]); });
        return () => { cancelled = true; };
    }, [projectRef]);

    // Runtime switches clear resolved catalogs; project starters reload from
    // the new server on next projectRef change (or clear until then).
    React.useEffect(() => {
        const unsubscribe = subscribeRuntimeEndpointChanged(() => {
            authoritativeDirsRef.current.clear();
            setAuthoritativeTick((t) => t + 1);
            setProjectStarters([]);
        });
        return unsubscribe;
    }, []);

    const ensureLoaded = React.useCallback(() => {
        if (effectiveDirectory) void loadPrompts(effectiveDirectory);
    }, [effectiveDirectory, loadPrompts]);

    React.useEffect(() => {
        if (!effectiveDirectory) return;
        let cancelled = false;
        const runtimeKey = getRuntimeKey();
        void loadPrompts(effectiveDirectory).then((ok) => {
            if (cancelled) return;
            if (getRuntimeKey() !== runtimeKey) return;
            if (ok) {
                authoritativeDirsRef.current.add(effectiveDirectory);
                setAuthoritativeTick((t) => t + 1);
            }
        });
        return () => { cancelled = true; };
    }, [effectiveDirectory, loadPrompts]);

    const expectedPromptCacheKey = promptTemplatesCacheKey(
        getRuntimeKey(),
        effectiveDirectory,
    );
    const activePromptScopeMatches = activePromptCacheKey === expectedPromptCacheKey;
    // Never resolve or offer prompts from the previous directory while the
    // effective directory's catalog is loading.
    const scopedPrompts = activePromptScopeMatches ? prompts : EMPTY_PROMPTS;

    // Authoritative prompt index for the effective directory: prefer project
    // override for same-named prompts (matching Pi `/name` resolution).
    const promptByName = React.useMemo(
        () => buildPromptWinnerMap(scopedPrompts),
        [scopedPrompts],
    );

    const isAuthoritative = effectiveDirectory
        ? activePromptScopeMatches && authoritativeDirsRef.current.has(effectiveDirectory)
        : false;
    // Touch the tick so authoritative updates re-resolve even when the Set
    // identity is stable.
    void authoritativeTick;

    const resolve = React.useCallback((ref: DraftStarterRef, group: StarterGroup): ResolvedStarter | null => {
        if (ref.type === 'text') {
            const builtin = BUILTIN_TEXT_STARTERS[ref.key];
            if (!builtin) return null;
            return {
                id: chipId(group, ref),
                ref,
                group,
                label: builtin.label,
                icon: builtin.icon,
                insertText: builtin.text,
                promptName: '',
            };
        }
        const prompt = promptByName.get(ref.name);
        if (!prompt) {
            // Only an authoritative catalog may mark unresolved (deletion).
            // Failures and never-loaded scopes preserve the chip.
            if (!isAuthoritative) {
                return {
                    id: chipId(group, ref),
                    ref,
                    group,
                    label: normalizeStarterLabel(ref.name),
                    icon: PROMPT_FALLBACK_ICON,
                    insertText: `/${ref.name} `,
                    promptName: ref.name,
                };
            }
            return null;
        }
        return {
            id: chipId(group, ref),
            ref,
            group,
            label: normalizeStarterLabel(ref.name),
            icon: PROMPT_FALLBACK_ICON,
            insertText: `/${ref.name} `,
            promptName: ref.name,
        };
    }, [promptByName, isAuthoritative]);

    const globalRefs = React.useMemo<readonly DraftStarterRef[]>(
        () => globalRaw ?? DEFAULT_GLOBAL_STARTERS,
        [globalRaw],
    );

    const globalResolved = React.useMemo(
        () => globalRefs.map((r) => resolve(r, 'global')).filter((x): x is ResolvedStarter => x !== null),
        [globalRefs, resolve],
    );
    const projectResolved = React.useMemo(
        () => projectStarters.map((r) => resolve(r, 'project')).filter((x): x is ResolvedStarter => x !== null),
        [projectStarters, resolve],
    );

    // Never show two chips that insert the same invocation. Project override
    // wins (it is what `/name` would invoke); global duplicate is hidden.
    const { global, project } = React.useMemo(
        () => dedupeStarterInvocations(projectResolved, globalResolved),
        [projectResolved, globalResolved],
    );

    const pinnedKeys = React.useMemo(() => {
        const set = new Set<string>();
        for (const r of globalRefs) set.add(starterKey(r));
        for (const r of projectStarters) set.add(starterKey(r));
        return set;
    }, [globalRefs, projectStarters]);

    const pinnable = React.useMemo<PinnableItem[]>(() => {
        // Starter picker lists editable, invokable native prompts from the
        // effective directory only. Skills and snippets are never pinnable.
        // Dedupe same-named global/project rows to the Pi winner (project).
        const byName = new Map<string, PinnableItem>();
        for (const prompt of scopedPrompts) {
            if (prompt.editable !== true) continue;
            if (prompt.location !== 'global' && prompt.location !== 'project') continue;
            const existing = byName.get(prompt.name);
            const scope: 'user' | 'project' = prompt.location === 'project' ? 'project' : 'user';
            const item: PinnableItem = {
                type: 'prompt',
                name: prompt.name,
                label: normalizeStarterLabel(prompt.name),
                icon: PROMPT_FALLBACK_ICON,
                section: 'prompt',
                scope,
            };
            if (!existing) {
                byName.set(prompt.name, item);
                continue;
            }
            if (scope === 'project' && existing.scope !== 'project') {
                byName.set(prompt.name, item);
            }
        }
        return [...byName.values()].filter(
            (item) => !pinnedKeys.has(`${item.type}:${item.name}`),
        );
    }, [scopedPrompts, pinnedKeys]);

    const persistGlobal = React.useCallback((next: DraftStarterRef[]) => {
        useUIStore.getState().setGlobalDraftStarters(next);
        void updateDesktopSettings({ draftStarters: next });
    }, []);

    const persistProject = React.useCallback((next: DraftStarterRef[]) => {
        setProjectStarters(next);
        if (projectRef) void saveProjectDraftStarters(projectRef, next);
    }, [projectRef]);

    const addStarter = React.useCallback((item: PinnableItem) => {
        if (item.type !== 'prompt') return;
        const ref: DraftStarterRef = { type: 'prompt', name: item.name };
        if (item.scope === 'project') {
            if (!projectRef || projectStarters.some((r) => sameStarter(r, ref))) return;
            persistProject([...projectStarters, ref]);
        } else {
            const base = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
            if (base.some((r) => sameStarter(r, ref))) return;
            persistGlobal([...base, ref]);
        }
    }, [projectRef, projectStarters, globalRaw, persistProject, persistGlobal]);

    const removeStarter = React.useCallback((group: StarterGroup, ref: DraftStarterRef) => {
        if (group === 'project') {
            persistProject(projectStarters.filter((r) => !sameStarter(r, ref)));
        } else {
            const base = globalRaw ?? DEFAULT_GLOBAL_STARTERS;
            persistGlobal(base.filter((r) => !sameStarter(r, ref)));
        }
    }, [projectStarters, globalRaw, persistProject, persistGlobal]);

    const reorder = React.useCallback((group: StarterGroup, fromId: string, toId: string) => {
        const base = group === 'project' ? projectStarters : (globalRaw ?? DEFAULT_GLOBAL_STARTERS);
        const from = base.findIndex((r) => chipId(group, r) === fromId);
        const to = base.findIndex((r) => chipId(group, r) === toId);
        if (from < 0 || to < 0 || from === to) return;
        const next = arrayMove([...base], from, to);
        if (group === 'project') persistProject(next); else persistGlobal(next);
    }, [projectStarters, globalRaw, persistProject, persistGlobal]);

    return { global, project, pinnable, hasProject: !!projectRef, ensureLoaded, addStarter, removeStarter, reorder };
}
