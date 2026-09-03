import React from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { getProjectDraftStarters, saveProjectDraftStarters } from '@/lib/pichamberConfig';
import type { IconName } from '@/components/icon/icons';
import {
    DEFAULT_GLOBAL_STARTERS,
    SKILL_FALLBACK_ICON,
    normalizeStarterLabel,
    sameStarter,
    starterKey,
    type DraftStarterRef,
    type DraftStarterType,
} from '@/lib/draftStarters';

type StarterGroup = 'global' | 'project';

export type ResolvedStarter = {
    id: string;
    ref: DraftStarterRef;
    group: StarterGroup;
    label: string;
    icon: IconName;
    submitText: string;
};

export type PinnableSection = 'skill';

export type PinnableItem = {
    type: DraftStarterType;
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

export function useDraftStarters(): UseDraftStartersResult {
    const globalRaw = useUIStore((s) => s.globalDraftStarters);
    const skills = useSkillsStore((s) => s.skills);
    const activeProjectId = useProjectsStore((s) => s.activeProjectId);
    const projects = useProjectsStore((s) => s.projects);

    const projectRef = React.useMemo(() => {
        if (!activeProjectId) return null;
        const found = projects.find((p) => p.id === activeProjectId);
        if (!found?.path) return null;
        return { id: found.id, path: found.path };
    }, [activeProjectId, projects]);

    const [projectStarters, setProjectStarters] = React.useState<DraftStarterRef[]>([]);

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

    const ensureLoaded = React.useCallback(() => {
        void useSkillsStore.getState().loadSkills?.();
    }, []);

    // Preload skills on mount so that pinned skill starters resolve immediately.
    React.useEffect(() => {
        ensureLoaded();
    }, [ensureLoaded]);

    const skillNames = React.useMemo(() => new Set(skills.map((s) => s.name)), [skills]);

    const resolve = React.useCallback((ref: DraftStarterRef, group: StarterGroup): ResolvedStarter | null => {
        // Command starters were PiChamber-owned and have been removed. Keep
        // accepting their persisted shape, but do not render or run them.
        if (ref.type === 'command') return null;
        if (!skillNames.has(ref.name)) return null;
        return { id: chipId(group, ref), ref, group, label: normalizeStarterLabel(ref.name), icon: SKILL_FALLBACK_ICON, submitText: `/${ref.name}` };
    }, [skillNames]);

    const globalRefs = React.useMemo<readonly DraftStarterRef[]>(
        () => globalRaw ?? DEFAULT_GLOBAL_STARTERS,
        [globalRaw],
    );

    const global = React.useMemo(
        () => globalRefs.map((r) => resolve(r, 'global')).filter((x): x is ResolvedStarter => x !== null),
        [globalRefs, resolve],
    );
    const project = React.useMemo(
        () => projectStarters.map((r) => resolve(r, 'project')).filter((x): x is ResolvedStarter => x !== null),
        [projectStarters, resolve],
    );

    const pinnedKeys = React.useMemo(() => {
        const set = new Set<string>();
        for (const r of globalRefs) set.add(starterKey(r));
        for (const r of projectStarters) set.add(starterKey(r));
        return set;
    }, [globalRefs, projectStarters]);

    const pinnable = React.useMemo<PinnableItem[]>(() => {
        const items: PinnableItem[] = skills.map((sk) => ({
            type: 'skill',
            name: sk.name,
            label: normalizeStarterLabel(sk.name),
            icon: SKILL_FALLBACK_ICON,
            section: 'skill',
            scope: sk.scope === 'project' ? 'project' : 'user',
        }));
        // Only offer items that are not already pinned.
        return items.filter((item) => !pinnedKeys.has(`${item.type}:${item.name}`));
    }, [skills, pinnedKeys]);

    const persistGlobal = React.useCallback((next: DraftStarterRef[]) => {
        useUIStore.getState().setGlobalDraftStarters(next);
        void updateDesktopSettings({ draftStarters: next });
    }, []);

    const persistProject = React.useCallback((next: DraftStarterRef[]) => {
        setProjectStarters(next);
        if (projectRef) void saveProjectDraftStarters(projectRef, next);
    }, [projectRef]);

    const addStarter = React.useCallback((item: PinnableItem) => {
        const ref: DraftStarterRef = { type: item.type, name: item.name };
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
