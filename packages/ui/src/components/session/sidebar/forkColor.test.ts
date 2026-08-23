import { describe, expect, test } from 'bun:test';

import { getForkBackgroundColor, getForkColor, getForkColorIdForSession } from './forkColor';

describe('fork color', () => {
  test('is deterministic for the same session', () => {
    expect(getForkColor('ses_root_1')).toBe(getForkColor('ses_root_1'));
    expect(getForkColor('ses_root_1')).not.toBeNull();
  });

  test('a fork promoted to parent starts a new color family', () => {
    const parentById = new Map<string, string | null>([
      ['root', null],
      ['fork', 'root'],
      ['nested-fork', 'fork'],
      ['nested-sibling', 'fork'],
    ]);
    const childrenCountById = new Map<string, number>([
      ['root', 1],
      ['fork', 2],
    ]);

    expect(getForkColorIdForSession('root', parentById, childrenCountById)).toBe('root');
    expect(getForkColorIdForSession('fork', parentById, childrenCountById)).toBe('fork');
    expect(getForkColorIdForSession('nested-fork', parentById, childrenCountById)).toBe('fork');
    expect(getForkColorIdForSession('nested-sibling', parentById, childrenCountById)).toBe('fork');
  });

  test('a leaf fork shares its parent family until it is forked', () => {
    const parentById = new Map<string, string | null>([
      ['root', null],
      ['fork', 'root'],
    ]);
    const childrenCountById = new Map<string, number>([['root', 1]]);

    expect(getForkColorIdForSession('fork', parentById, childrenCountById)).toBe('root');
    childrenCountById.set('fork', 1);
    expect(getForkColorIdForSession('fork', parentById, childrenCountById)).toBe('fork');
  });

  test('sessions outside a fork relationship can omit color', () => {
    expect(getForkColor(null)).toBeNull();
  });

  test('uses theme-aware background tints', () => {
    const solid = getForkColor('ses_fork');
    expect(getForkBackgroundColor('ses_fork')).toBe(
      `color-mix(in srgb, ${solid} 18%, transparent)`,
    );
    expect(getForkBackgroundColor('ses_fork', { active: true })).toBe(
      `color-mix(in srgb, ${solid} 30%, var(--interactive-selection))`,
    );
  });
});
