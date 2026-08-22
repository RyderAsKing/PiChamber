import { describe, expect, test } from 'bun:test';

import { canShowQuickArchiveAction } from './sessionQuickActions';

describe('session quick archive availability', () => {
  test('is available on pointer-oriented desktop layouts', () => {
    expect(canShowQuickArchiveAction({ mobileVariant: false, isTablet: false })).toBe(true);
  });

  test('is unavailable on tablet and dedicated mobile layouts', () => {
    expect(canShowQuickArchiveAction({ mobileVariant: false, isTablet: true })).toBe(false);
    expect(canShowQuickArchiveAction({ mobileVariant: true, isTablet: true })).toBe(false);
    expect(canShowQuickArchiveAction({ mobileVariant: true, isTablet: false })).toBe(false);
  });
});
