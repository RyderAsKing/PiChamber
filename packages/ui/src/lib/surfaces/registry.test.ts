import { describe, expect, test } from 'bun:test';

import {
  CONTEXT_SURFACES,
  getVisibleContextRailSurfaces,
} from './registry';

const baseOptions = {
  railOrder: [],
  screenWidth: 1200,
  tabs: [],
} as const;

describe('getVisibleContextRailSurfaces', () => {
  test('never restores walkthrough on the Pi shell', () => {
    const surfaces = getVisibleContextRailSurfaces({ ...baseOptions, screenWidth: 2400 });
    expect(surfaces.some((surface) => surface.id === 'walkthrough')).toBe(false);
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
});
