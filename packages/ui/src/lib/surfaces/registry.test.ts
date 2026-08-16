import { describe, expect, test } from 'bun:test';

import {
  CONTEXT_SURFACES,
  getGitRailPresentation,
  getVisibleContextRailSurfaces,
} from './registry';

const baseOptions = {
  railOrder: [],
  screenWidth: 1200,
  tabs: [],
} as const;

describe('getVisibleContextRailSurfaces', () => {
  test('does not include removed surfaces like walkthrough', () => {
    const surfaces = getVisibleContextRailSurfaces({ ...baseOptions, screenWidth: 2400 });
    expect(CONTEXT_SURFACES.some((surface: { id: string }) => surface.id === 'walkthrough')).toBe(false);
    expect(surfaces.some((surface) => surface.id === 'context')).toBe(true);
  });

  test('hides content-driven surfaces until a matching tab exists', () => {
    const preview = CONTEXT_SURFACES.find((surface) => surface.id === 'preview');
    if (!preview) {
      throw new Error('preview surface missing from registry');
    }
    expect(preview.availability).toBe('has-content');
    expect(getVisibleContextRailSurfaces(baseOptions).some((s) => s.id === 'preview')).toBe(false);
    expect(getVisibleContextRailSurfaces({ ...baseOptions, tabs: [{ mode: preview.mode }] }).some((s) => s.id === 'preview')).toBe(true);
  });

  test('respects the persisted user rail order', () => {
    const surfaces = getVisibleContextRailSurfaces({ ...baseOptions, railOrder: ['git', 'context'] });
    expect(surfaces.slice(0, 2).map((surface) => surface.id)).toEqual(['git', 'context']);
  });

  test('puts Files directly under Context and omits a separate Changes surface', () => {
    const ids = CONTEXT_SURFACES.filter((surface) => surface.availability === 'always').map((surface) => surface.id);
    expect(ids.slice(0, 3)).toEqual(['context', 'editor', 'git']);
    expect(CONTEXT_SURFACES.map((surface) => surface.id)).not.toContain('diff');
    expect(CONTEXT_SURFACES.map((surface) => surface.id)).not.toContain('pr');
    expect(CONTEXT_SURFACES.find((surface) => surface.id === 'editor')?.icon).toBe('file-text');
  });

  test('uses the Changes icon when the directory is not a git repository', () => {
    expect(getGitRailPresentation(true).icon).toBe('git-branch');
    expect(getGitRailPresentation(true).label).toBe('Git');
    expect(getGitRailPresentation(null).icon).toBe('git-branch');
    expect(getGitRailPresentation(false)).toEqual({
      icon: 'arrow-left-right',
      label: 'Changes',
      description: 'Review working and last-turn changes',
    });
  });
});
