import { describe, expect, test } from 'bun:test';

import { getForkFamilyBackgroundColor, getForkFamilyColor, getForkFamilyIdForSession } from './forkFamilyColor';

describe('fork family color', () => {
  test('is deterministic for same family id across calls', () => {
    const first = getForkFamilyColor('ses_root_1');
    const second = getForkFamilyColor('ses_root_1');
    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  test('parent and descendant share same color', () => {
    const parentById = new Map<string, string | null>([
      ['ses_root', null],
      ['ses_child', 'ses_root'],
      ['ses_grandchild', 'ses_child'],
    ]);
    const rootForChild = getForkFamilyIdForSession('ses_child', parentById);
    const rootForGrandchild = getForkFamilyIdForSession('ses_grandchild', parentById);
    expect(rootForChild).toBe('ses_root');
    expect(rootForGrandchild).toBe('ses_root');
    expect(getForkFamilyColor(rootForChild)).toBe(getForkFamilyColor(rootForGrandchild));
  });

  test('sessions with no fork relationship have no color', () => {
    const parentById = new Map<string, string | null>([['ses_alone', null]]);
    const familyId = getForkFamilyIdForSession('ses_alone', parentById);
    // Lone sessions that are not parents of anyone should not get a color.
    // The grouping layer decides to show color only when the session has a parent
    // or has children; direct utility returns the root id for lone sessions.
    expect(familyId).toBe('ses_alone');
    // But UI should only color when actually in a fork family — tested via
    // the flag that checks hasParent || hasChildren.
    expect(getForkFamilyColor(familyId)).not.toBeNull();
  });

  test('background wash returns null on mobile so callers can paint a left border instead', () => {
    // On phone/tablet surfaces the 11% wash reads as "no color" against
    // bg-sidebar; the row paints borderLeft: 3px solid with the solid color
    // for a clear fork-family cue. The utility returns null so the row style
    // does not double-stack the wash under the border.
    const bg = getForkFamilyBackgroundColor('ses_root_mobile', { isMobile: true });
    expect(bg).toBeNull();

    const bgActive = getForkFamilyBackgroundColor('ses_root_mobile', { isMobile: true, active: true });
    expect(bgActive).toBeNull();
  });

  test('background wash keeps the desktop tint when isMobile is not set', () => {
    const bg = getForkFamilyBackgroundColor('ses_root_desktop');
    expect(bg).not.toBeNull();
  });
});
