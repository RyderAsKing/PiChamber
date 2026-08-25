import { describe, expect, test } from 'bun:test';

import { getHeaderLocationLabel, getHeaderOpenDirectory } from '../headerLocation';

describe('getHeaderOpenDirectory', () => {
  test('uses the visible draft target instead of the stale selected session directory', () => {
    expect(getHeaderOpenDirectory({
      sessionDirectory: '/projects/old-project',
      draftDirectory: '~',
      isNewSessionDraftOpen: true,
    })).toBe('~');
  });

  test('uses the materialized session directory outside a new-session draft', () => {
    expect(getHeaderOpenDirectory({
      sessionDirectory: '/projects/pichamber',
      draftDirectory: '',
      isNewSessionDraftOpen: false,
    })).toBe('/projects/pichamber');
  });
});

describe('getHeaderLocationLabel', () => {
  test('hides the stale active project for a global new-session draft', () => {
    expect(getHeaderLocationLabel({
      activeProjectLabel: 'KhulaPolicy',
      openDirectory: '~',
      homeDirectory: '/home/ryder',
    })).toBeNull();
  });

  test('hides the stale active project for a materialized home session', () => {
    expect(getHeaderLocationLabel({
      activeProjectLabel: 'KhulaPolicy',
      openDirectory: '/home/ryder',
      homeDirectory: '/home/ryder',
    })).toBeNull();
  });

  test('keeps the active project label for a project session', () => {
    expect(getHeaderLocationLabel({
      activeProjectLabel: 'PiChamber',
      openDirectory: '/projects/pichamber',
      homeDirectory: '/home/ryder',
    })).toBe('PiChamber');
  });
});
