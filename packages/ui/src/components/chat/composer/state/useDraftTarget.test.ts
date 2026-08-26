import { describe, expect, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';
import {
  buildDraftTargetProjects,
  resolveDraftWelcomeProjectLabel,
  shouldSyncDraftTargetToActiveProject,
} from './draftTargetProjects';

const project = (id: string, path: string): ProjectEntry => ({ id, path } as ProjectEntry);

describe('buildDraftTargetProjects', () => {
  test('keeps the global target when a registered project is the home directory', () => {
    const targets = buildDraftTargetProjects(
      [project('home-project', '/root')],
      new Map(),
    );

    expect(targets.map((target) => target.id)).toEqual(['__home__', 'home-project']);
    expect(targets[0]?.id).toBe('__home__');
    expect(targets[0]?.label).toBe("Don't work in a folder");
    expect(targets[0]?.path).toBe('~');
  });

  test('does not replace an explicitly selected global target with the active project', () => {
    expect(shouldSyncDraftTargetToActiveProject({
      enabled: true,
      isDraftOpen: true,
      activeProjectId: 'app',
      selectedProjectId: '__home__',
    })).toBe(false);
  });

  test('does not show a registered project name for the global target', () => {
    expect(resolveDraftWelcomeProjectLabel({
      selectedProjectId: '__home__',
      activeProjectId: 'app',
      projects: [project('app', '/srv/app')],
    })).toBeNull();
  });

  test('keeps the global target when the home directory is not registered', () => {
    const targets = buildDraftTargetProjects(
      [project('app', '/srv/app')],
      new Map(),
    );

    expect(targets[0]?.id).toBe('__home__');
    expect(targets[0]?.path).toBe('~');
  });
});
